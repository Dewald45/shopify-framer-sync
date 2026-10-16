// Runs the Shopify → Framer sync against the live Framer project, then publishes
// the site to production if anything changed.
//
// To keep Framer traffic low, it first reads the catalogue from Shopify and compares it with
// the last sync (stored in .state/, kept between GitHub runs by the Actions cache). Framer is
// only contacted when the catalogue changed, or once every FULL_CHECK_HOURS as a safety net.
//
// Env: FRAMER_API_KEY, FRAMER_PROJECT_URL, SHOPIFY_STORE_DOMAIN, SHOPIFY_STOREFRONT_TOKEN
// Optional: BRAND_KEYS (comma-separated brand names for the shop filters), SKIP_PUBLISH=1,
//           FORCE_SYNC=1 (ignore the stored state)
import crypto from "node:crypto"
import fs from "node:fs"
import { appendFileSync } from "node:fs"
import { createRequire } from "node:module"
import { connect } from "framer-api"

const require = createRequire(import.meta.url)
const { syncShopifyToFramer, fetchShopifyProducts, productFingerprint } = require("./sync-core.cjs")

const required = ["FRAMER_API_KEY", "FRAMER_PROJECT_URL", "SHOPIFY_STORE_DOMAIN", "SHOPIFY_STOREFRONT_TOKEN"]
const missing = required.filter((k) => !process.env[k])
if (missing.length) throw new Error("Missing env: " + missing.join(", "))
const projectUrl = process.env.FRAMER_PROJECT_URL
const domain = process.env.SHOPIFY_STORE_DOMAIN
const token = process.env.SHOPIFY_STOREFRONT_TOKEN
const brandKeys = (process.env.BRAND_KEYS ?? "").split(",").map((s) => s.trim()).filter(Boolean)

const FULL_CHECK_HOURS = 24
const stateDir = new URL("./.state/", import.meta.url)
const stateFile = new URL("last-sync.json", stateDir)

const products = await fetchShopifyProducts({ domain, token })
// Stored as a hash only: the repo is public and the cache must not reveal product names.
const catalog = crypto
    .createHash("sha256")
    .update(products.map((p) => p.handle + ":" + productFingerprint(p)).sort().join("|") + "|" + brandKeys.join(","))
    .digest("hex")

let last = null
try {
    last = JSON.parse(fs.readFileSync(stateFile, "utf8"))
} catch {}
const fullCheckDue = !last || Date.now() - last.checkedAt > FULL_CHECK_HOURS * 3_600_000
if (process.env.FORCE_SYNC !== "1" && !fullCheckDue && last.catalog === catalog) {
    console.log(`Shopify: ${products.length} products, unchanged since last sync. Framer not contacted.`)
    process.exit(0)
}

const framer = await connect(projectUrl, process.env.FRAMER_API_KEY)
try {
    const { changed } = await syncShopifyToFramer(framer, { domain, token, brandKeys, prefetched: products })
    if (changed && process.env.SKIP_PUBLISH !== "1") {
        const { deployment } = await framer.publish()
        const hostnames = await framer.deploy(deployment.id)
        console.log("Published:", hostnames.map((h) => h.hostname).join(", "))
    }
} finally {
    await framer.disconnect()
}

// Only remembered after a successful sync, so a failed run is retried next time.
fs.mkdirSync(stateDir, { recursive: true })
fs.writeFileSync(stateFile, JSON.stringify({ catalog, checkedAt: Date.now() }))
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, "state_changed=true\n")
