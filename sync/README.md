# Shopify → Framer sync

Shopify is the source of truth for products. This job copies every product that is
published to the **Headless** sales channel into the Framer "Products" CMS collection,
removes products that were deleted/unpublished in Shopify, refreshes the shop-grid
snapshot (`ShopifyCatalog.tsx`), and publishes the Framer site when anything changed.

## Field mapping

| Shopify                                   | Framer CMS (Products)  |
|-------------------------------------------|------------------------|
| Title                                     | Name                   |
| Handle                                    | Slug (`/product/<handle>`) |
| Description                               | Description            |
| Featured image / other images             | Image / Gallery        |
| Lowest variant price                      | Price + Price Label    |
| Available for sale (any variant in stock) | In Stock               |
| Tag `featured`                            | Featured               |
| First variant SKU                         | SKU                    |
| Vendor                                    | Brand                  |
| Collection whose handle matches a site category (or Product type) | Category |
| Metafield `custom.specifications`         | Specifications         |
| Metafield `custom.parts_list` (file)      | Parts List PDF         |

Price, stock and variants on the product page and in the cart are also read **live**
from Shopify in the browser, so they are correct even between syncs.

## Settings

All settings are GitHub Actions secrets (nothing store-specific lives in the code):

| Secret                     | Value                                                    |
|----------------------------|----------------------------------------------------------|
| `FRAMER_API_KEY`           | Framer project → Settings → API Keys                     |
| `FRAMER_PROJECT_URL`       | The Framer project's URL                                 |
| `SHOPIFY_STORE_DOMAIN`     | `your-store.myshopify.com`                               |
| `SHOPIFY_STOREFRONT_TOKEN` | Storefront API token (Headless sales channel)            |
| `BRAND_KEYS`               | Optional: comma-separated brand names for shop filters   |

## Running

Automatically every 5 minutes via `.github/workflows/shopify-sync.yml`, or with
**Run workflow** in the Actions tab. Locally:

```bash
cd sync && npm install
FRAMER_API_KEY=... FRAMER_PROJECT_URL=... SHOPIFY_STORE_DOMAIN=... SHOPIFY_STOREFRONT_TOKEN=... npm run sync
```

`SKIP_PUBLISH=1` syncs the CMS without publishing.
