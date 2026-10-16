// Runs the Shopify → Framer sync against the live Framer project, then publishes
// the site to production if anything changed.
//
// Env: FRAMER_API_KEY, FRAMER_PROJECT_URL, SHOPIFY_STORE_DOMAIN, SHOPIFY_STOREFRONT_TOKEN
// Optional: BRAND_KEYS (comma-separated brand names for the shop filters), SKIP_PUBLISH=1
import { connect } from "framer-api"
import { createRequire } from "node:module"

const require = createRequire(import.meta.url)
const { syncShopifyToFramer } = require("./sync-core.cjs")

const required = ["FRAMER_API_KEY", "FRAMER_PROJECT_URL", "SHOPIFY_STORE_DOMAIN", "SHOPIFY_STOREFRONT_TOKEN"]
const missing = required.filter((k) => !process.env[k])
if (missing.length) throw new Error("Missing env: " + missing.join(", "))
const projectUrl = process.env.FRAMER_PROJECT_URL
const domain = process.env.SHOPIFY_STORE_DOMAIN
const token = process.env.SHOPIFY_STOREFRONT_TOKEN
const brandKeys = (process.env.BRAND_KEYS ?? "").split(",").map((s) => s.trim()).filter(Boolean)

const framer = await connect(projectUrl, process.env.FRAMER_API_KEY)
try {
    const { changed } = await syncShopifyToFramer(framer, { domain, token, brandKeys })
    if (changed && process.env.SKIP_PUBLISH !== "1") {
        const { deployment } = await framer.publish()
        const hostnames = await framer.deploy(deployment.id)
        console.log("Published:", hostnames.map((h) => h.hostname).join(", "))
    }
} finally {
    await framer.disconnect()
}
