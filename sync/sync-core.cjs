// Shopify → Framer product sync.
//
// Shopify is the source of truth. Every run:
//   1. pulls every product published to the Headless channel (Storefront API)
//   2. upserts them into the Framer "Products" CMS collection (keyed by handle = slug)
//   3. removes CMS products that no longer exist in Shopify
//   4. rewrites the ShopifyCatalog.tsx code file (snapshot used by the shop grids)
// and returns { changed } so the caller can decide whether to publish.
//
// This file is plain JS with no imports so it can run both from Node (run-sync.mjs)
// and inside a Framer agent session.

const SHOPIFY_API_VERSION = "2025-10"

const PRODUCTS_QUERY = `
query Products($cursor: String) {
  products(first: 100, after: $cursor, sortKey: CREATED_AT) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id handle title vendor productType tags descriptionHtml availableForSale updatedAt
      featuredImage { url altText }
      images(first: 20) { nodes { url altText } }
      priceRange { minVariantPrice { amount currencyCode } }
      compareAtPriceRange { maxVariantPrice { amount } }
      collections(first: 20) { nodes { handle title } }
      variants(first: 1) { nodes { sku } }
      specifications: metafield(namespace: "custom", key: "specifications") { value type }
      partsList: metafield(namespace: "custom", key: "parts_list") { reference { ... on GenericFile { url } } }
    }
  }
}`

async function fetchShopifyProducts({ domain, token }) {
    const all = []
    let cursor = null
    do {
        const res = await fetch(`https://${domain}/api/${SHOPIFY_API_VERSION}/graphql.json`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "X-Shopify-Storefront-Access-Token": token },
            body: JSON.stringify({ query: PRODUCTS_QUERY, variables: { cursor } }),
        })
        const json = await res.json()
        if (json.errors) throw new Error("Shopify: " + JSON.stringify(json.errors))
        const page = json.data.products
        all.push(...page.nodes)
        cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null
    } while (cursor)
    return all
}

// "R 14 375" / "R 1 989.50" — matches the format the site already used.
function priceLabel(amount) {
    if (!amount) return "Price on request"
    const [whole, cents] = Number(amount).toFixed(2).split(".")
    const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, " ")
    return `R ${grouped}${cents === "00" ? "" : "." + cents}`
}

// Short brand key used by the shop filters: the first configured key the vendor name contains
// (e.g. vendor "Acme Tools" → "Acme"), otherwise the vendor as-is.
function brandKey(vendor, brandKeys = []) {
    const v = (vendor || "").toLowerCase()
    for (const k of brandKeys) if (v.includes(k.toLowerCase())) return k
    return vendor || ""
}

const slugify = (s) =>
    (s || "").toLowerCase().normalize("NFKD").replace(/[^\w\s-]/g, "").trim().replace(/[\s_]+/g, "-")

// Category = the first Shopify collection whose handle matches a website category,
// otherwise the product type (slugified) if it matches one.
function categorySlug(p, categorySlugs) {
    for (const c of p.collections.nodes) if (categorySlugs.has(c.handle)) return c.handle
    const t = slugify(p.productType)
    return categorySlugs.has(t) ? t : ""
}

// Shopify rich-text metafields are JSON; render the subset Shopify's editor produces.
function richTextToHtml(node) {
    if (!node) return ""
    const kids = () => (node.children || []).map(richTextToHtml).join("")
    switch (node.type) {
        case "root": return kids()
        case "paragraph": return `<p>${kids()}</p>`
        case "heading": return `<h${node.level || 3}>${kids()}</h${node.level || 3}>`
        case "list": return node.listType === "ordered" ? `<ol>${kids()}</ol>` : `<ul>${kids()}</ul>`
        case "list-item": return `<li>${kids()}</li>`
        case "link": return `<a href="${node.url}">${kids()}</a>`
        case "text": {
            let t = (node.value || "").replace(/&/g, "&amp;").replace(/</g, "&lt;")
            if (node.bold) t = `<strong>${t}</strong>`
            if (node.italic) t = `<em>${t}</em>`
            return t
        }
        default: return kids()
    }
}

function specificationsHtml(mf) {
    if (!mf || !mf.value) return ""
    if (mf.type === "rich_text_field") {
        try { return richTextToHtml(JSON.parse(mf.value)) } catch { return "" }
    }
    // multi_line_text_field: "Label: value" per line → spec table
    const rows = mf.value.split(/\r?\n/).map((l) => l.split(/:\s*/)).filter((r) => r[0])
    if (rows.every((r) => r.length >= 2))
        return `<figure><table><tbody>${rows.map((r) => `<tr><td><p>${r[0]}</p></td><td><p>${r.slice(1).join(": ")}</p></td></tr>`).join("")}</tbody></table></figure>`
    return mf.value.split(/\r?\n/).map((l) => `<p>${l}</p>`).join("")
}

// Hash of everything the website shows for a product. Leaves out updatedAt, which Shopify
// can bump for changes the site doesn't display (e.g. stock counts after an order).
function productFingerprint(p) {
    const json = JSON.stringify({ ...p, updatedAt: undefined })
    let h = 5381
    for (let i = 0; i < json.length; i++) h = ((h << 5) + h + json.charCodeAt(i)) | 0
    return (h >>> 0).toString(36) + json.length.toString(36)
}

async function syncShopifyToFramer(framer, { domain, token, brandKeys = [], prefetched, log = console.log }) {
    const shopifyProducts = prefetched ?? (await fetchShopifyProducts({ domain, token }))
    log(`Shopify: ${shopifyProducts.length} products`)

    const collections = await framer.getCollections()
    const products = collections.find((c) => c.name === "Products")
    const categories = collections.find((c) => c.name === "Categories")
    const fields = await products.getFields()
    const F = Object.fromEntries(fields.map((f) => [f.name, f]))
    const galleryImageField = F["Gallery"].fields[0].id

    const categoryItems = await categories.getItems()
    const categoryIdBySlug = Object.fromEntries(categoryItems.map((c) => [c.slug, c.id]))
    const categorySlugs = new Set(Object.keys(categoryIdBySlug))

    const existing = await products.getItems()
    const existingBySlug = new Map(existing.map((i) => [i.slug, i]))

    const rows = []
    const gallery = {}
    const upserts = []

    shopifyProducts.forEach((p, index) => {
        const price = Number(p.priceRange.minVariantPrice.amount)
        const cat = categorySlug(p, categorySlugs)
        const featured = p.tags.some((t) => t.toLowerCase() === "featured")
        const images = p.images.nodes
        const mainImage = p.featuredImage || images[0]
        const fieldData = {
            [F["Name"].id]: { type: "string", value: p.title },
            [F["Slug"].id]: { type: "string", value: p.handle },
            [F["Price"].id]: { type: "number", value: price },
            [F["Price Label"].id]: { type: "string", value: priceLabel(price) },
            [F["In Stock"].id]: { type: "boolean", value: p.availableForSale },
            [F["Featured"].id]: { type: "boolean", value: featured },
            [F["SKU"].id]: { type: "string", value: p.variants.nodes[0]?.sku || "" },
            [F["Brand"].id]: { type: "string", value: p.vendor || "" },
            [F["Order"].id]: { type: "number", value: index },
            [F["Description"].id]: { type: "formattedText", value: p.descriptionHtml || "" },
            [F["Specifications"].id]: { type: "formattedText", value: specificationsHtml(p.specifications) },
            [F["Live Product URL"].id]: { type: "link", value: null },
            [F["Image"].id]: { type: "image", value: mainImage ? mainImage.url : null, alt: mainImage?.altText || p.title },
            [F["Gallery"].id]: {
                type: "array",
                value: images.slice(1).map((img) => ({
                    fieldData: { [galleryImageField]: { type: "image", value: img.url, alt: img.altText || p.title } },
                })),
            },
            [F["Category"].id]: { type: "collectionReference", value: categoryIdBySlug[cat] || null },
            [F["Parts List PDF"].id]: { type: "file", value: p.partsList?.reference?.url || null },
        }
        const current = existingBySlug.get(p.handle)
        upserts.push(current ? { id: current.id, slug: p.handle, fieldData } : { slug: p.handle, fieldData })

        rows.push([p.handle, p.title, price, priceLabel(price), p.availableForSale ? 1 : 0,
            mainImage ? mainImage.url + (mainImage.url.includes("?") ? "&" : "?") + "width=512" : "",
            cat, brandKey(p.vendor, brandKeys), featured ? 1 : 0])
        gallery[p.handle] = images.slice(1).map((i) => i.url)
    })

    // Skip unchanged products by comparing a fingerprint stored on the item via plugin data.
    let changed = false
    const toWrite = []
    for (const u of upserts) {
        const src = shopifyProducts.find((p) => p.handle === u.slug)
        const fp = productFingerprint(src)
        const cur = u.id && existingBySlug.get(u.slug)
        const prev = cur ? await cur.getPluginData("shopifyFingerprint") : null
        if (prev !== fp) toWrite.push({ u, cur, fp })
    }
    if (toWrite.length) {
        changed = true
        const newOnes = toWrite.filter((w) => !w.cur).map((w) => w.u)
        if (newOnes.length) await products.addItems(newOnes)
        for (const w of toWrite.filter((w) => w.cur)) await w.cur.setAttributes({ fieldData: w.u.fieldData })
        const refreshed = await products.getItems()
        for (const w of toWrite) {
            const item = refreshed.find((i) => i.slug === w.u.slug)
            if (item) await item.setPluginData("shopifyFingerprint", w.fp)
        }
        log(`Framer: wrote ${toWrite.length} products (${newOnes.length} new)`)
    }

    const keep = new Set(shopifyProducts.map((p) => p.handle))
    const stale = existing.filter((i) => !keep.has(i.slug)).map((i) => i.id)
    if (stale.length) {
        changed = true
        await products.removeItems(stale)
        log(`Framer: removed ${stale.length} products no longer in Shopify`)
    }

    // Snapshot for the shop grids (first paint + SEO); they refresh live from Shopify in the browser.
    const catalogSource =
        `// AUTO-GENERATED by the Shopify sync — do not edit by hand.\n` +
        `// [handle, title, price, priceLabel, inStock, image, categorySlug, brand, featured]\n` +
        `export const SNAPSHOT_PRODUCTS: [string,string,number,string,number,string,string,string,number][] = ${JSON.stringify(rows)}\n` +
        `export const SNAPSHOT_GALLERY: Record<string, string[]> = ${JSON.stringify(gallery)}\n`
    const codeFiles = await framer.getCodeFiles()
    const catalogFile = codeFiles.find((f) => f.name === "ShopifyCatalog.tsx")
    if (!catalogFile) {
        await framer.createCodeFile("ShopifyCatalog.tsx", catalogSource)
        changed = true
    } else if (catalogFile.content !== catalogSource) {
        await catalogFile.setFileContent(catalogSource)
        changed = true
    }

    log(changed ? "Sync complete: changes written" : "Sync complete: already up to date")
    return { changed, count: shopifyProducts.length }
}

if (typeof module !== "undefined") module.exports = { syncShopifyToFramer, fetchShopifyProducts, productFingerprint, priceLabel }
