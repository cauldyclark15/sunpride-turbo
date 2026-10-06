# Pricing and promotion intake (for Sunpride)

These two files tell us how Sunpride prices and promotes products, so the van handheld and field apps can price
sales offline. Keep the header row exactly as it is. Delete the rows marked `EXAMPLE`. One row per price or
promotion. Dates are Manila dates (YYYY-MM-DD); `effective_to` is the first day the row no longer applies (blank =
open-ended).

## price-list.csv

| Column                        | Meaning                                                                             |
| ----------------------------- | ----------------------------------------------------------------------------------- |
| price_list_code               | Your name/code for the price list                                                   |
| scope_level                   | Who the price is for: `base` (everyone), `channel`, `customer_group`, or `customer` |
| scope_code                    | The channel, group or customer code (blank for `base`)                              |
| product_code                  | Same code as the product master                                                     |
| selling_uom                   | The unit the price is for (e.g. CASE, EACH)                                         |
| unit_price                    | Price per selling unit, two decimals                                                |
| currency                      | PHP                                                                                 |
| vat_inclusive                 | Y if the price includes VAT, N if not                                               |
| effective_from / effective_to | When the price applies                                                              |

## promotions.csv

| Column                             | Meaning                                                                                                                            |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| promotion_code, description        | Your code and a plain description                                                                                                  |
| rule_type                          | `percent_off`, `amount_off`, `buy_x_get_y` (free goods) or `tier_price`. If a promotion fits none of these, describe it in `notes` |
| scope_level, scope_code            | Who it applies to, as above                                                                                                        |
| product_code, selling_uom          | The product the promotion is on                                                                                                    |
| min_quantity                       | Minimum quantity in that unit to qualify                                                                                           |
| discount_percent / discount_amount | For percent/amount off                                                                                                             |
| free_product_code, free_quantity   | For free goods                                                                                                                     |
| tier_unit_price                    | For tier prices                                                                                                                    |
| priority                           | Lower number is applied first when several promotions match                                                                        |
| stackable                          | Y if it can combine with other promotions, N if not                                                                                |
| effective_from / effective_to      | When the promotion runs                                                                                                            |

## Questions to answer with the files

1. Which price levels do you use: base only, by channel, by customer group, per customer with exceptions?
2. May a salesperson change a price on the handheld? If yes, who, by how much at most, and does a supervisor approve?
3. Are prices VAT-inclusive on receipts?
4. Can two promotions combine on the same line or the same sale?
