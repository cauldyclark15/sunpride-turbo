# Sunpride Field: Customer mapping mode guide screenshots

These screenshots come from the Xiaomi Redmi test phone (720x1600). The app is the DEV build of `origin/main` 6ecf1384, connected to a LANE test server with sample data. The account is `agent@sunpride.test` with `app_mode = mapping`. No live data was used.

| File | What it shows |
|---|---|
| `g01-home-empty.png` | Home, right after sign-in. Shows the "Home" title with the date "Wed, Nov 18", the "All sent" chip, and the Messages (speech bubble) and Account icons at the top right. Below that are the big red "+ Add customer" button, the "0 Added today" and "0 This week" cards, and "Last saved" with "Customers you add show here." The bottom bar reads Home · Customers · More. |
| `g02-add-customer-form.png` | The "Add customer" form opened from the Home button, at the top of the form, with no error banner. Shows the note "Saved customers stay encrypted on this phone until the next sync.", the "Customer General Information" section (Registered Name *, Trade Name, Customer Name *, Customer Address *, Email Address) and the fixed "Save customer" button. |
| `g03-add-customer-filled.png` | The same form filled in: Registered Name "Aling Nena Sari-Sari Store", Trade Name "Aling Nena Store", Customer Name "Nena Reyes", Customer Address "123 Rizal Street, Lahug, Cebu City". The top note now reads "Storefront photo saved for this customer." The "Discard and start again" and "Save customer" buttons sit at the bottom. |
| `g04-save-button.png` | The bottom of the filled form: the CDM note, the "Storefront photo" card with "Retake storefront photo" and the captured photo, then "Discard and start again" and "Save customer". The photo is black because the phone's camera was facing a dark surface. A real storefront shot will appear there instead. |
| `g05-home-after-save.png` | Home after two sample customers were saved: "2 Added today", "2 This week". Under "Last saved": "Benjamin Cruz / Camputhaw – Sent" and "Nena Reyes / Lahug – Sent". |
| `g06-customers-tab.png` | The Customers tab: "Search name, code or address", the "All 75" and "On today's route 25" filters, "75 customers", sample rows such as "Sample Mabuhay Sari-sari 24 · SMP-C0024 · Today · Done", and the "+ Add customer" button. |
| `g07-messages.png` | Messages, opened from the top-right speech-bubble icon. Under "DIRECT MESSAGES" there is one lane-only sample conversation with "Sample Elena Supervisor" ("You: Good morning po. I added 2 new stores today in Lahug and Camputhaw."). The pencil button starts a new conversation. |
| `g08-more.png` | More in Customer mapping mode. "Your work" lists Products ("Search and scan. Works offline") and Add customer ("Works offline"). "This phone" lists Sync ("All sent") and "Keep location sharing on". "Account and help" lists Account ("Fingerprint, password, phone") and "Support info" (partly visible). |
| `g09-sync.png` | Sync page: Status "All sent", "Last sent Nov 18, 2026 5:28 am", and the "Sync now" button. |

Both saved customers reached the lane server as **pending** new-store requests waiting for office approval.

## Add customer form: required fields (exact on-screen labels)

These are the fields marked with `*`, in form order.

- Customer General Information: **Registered Name \***, **Customer Name \***, **Customer Address \***, **Mobile No. \***, **Tax Classification \***. Optional: Trade Name, Email Address, Tel. No., TIN number.
- Customer Location:
  - **Country \*** is prefilled with "Philippines (PH)".
  - The location pickers fill in order: **Region \***, **Province \***, **Municipality \***, **Barangay \***.
  - **Postal Code \*** is a picker that appears once a Municipality is chosen.
  - **Geographical Coordinates \*** is filled by the "Use my location" button. It shows "lat, long · ±N m" and needs better than ±50 m.
  - Optional: House No., Street 1, Street 2, Floor, Room No. / Stall No.
- Customer Assignment:
  - **Sales Organization \*** is prefilled with "SFI (1000)".
  - **Sales Office \***, **Distribution Channel \***, **Customer Grp 1 \*** (after Distribution Channel), **Customer Grp 2 \*** (after Customer Grp 1), **Customer Group \***, **Type of Business \***.
  - Optional: Sales Partner.
- Payment Arrangement: **Terms of payment \***, **Customer Pricing Procedure \***. Optional: Credit Limit.
- Delivery Arrangement:
  - **Delivering Plant \***.
  - The checkbox "Ship-to is the same as the customer" was ticked when the form opened. While it is ticked, **Ship-to Party \***, **Ship-to Address \*** and the ship-to **Mobile No. \*** are copied from the customer and greyed out.
  - **Contact Person \*** must always be typed.
- **Storefront photo**: it has no `*`, but the app requires it ("Take a storefront photo"). Use "Open storefront camera", then "Take storefront photo".

Sample values used:
- Tax Classification: "Liable for Taxes (1)".
- Location: Region VII (Central Visayas) / Cebu / City of Cebu / Lahug (or Camputhaw), postal code 6000.
- Customer Assignment: Sales Office "SFI Cebu (100)", Distribution Channel "General Trade (30)", Customer Grp 1 "Key Accounts 3 (KAS3)", Customer Grp 2 "GT-Retailers (GRT)", Customer Group "NO GROUP (74)", Type of Business "Sole Proprietor".
- Payment and delivery: Terms of payment "Cash upon delivery (ZC03)", Pricing "Standard Inclusive Tax (2)", Delivering Plant "Cebu Dry House (1010)".

## Things that looked wrong or confusing (report only; no code changed)

1. **Fields were cleared after taking the storefront photo.** This happened twice. On the second customer it went like this:
   - Before the photo, everything was filled in.
   - After "Take storefront photo", these were blank again: Registered Name, Customer Name, Mobile No., Tax Classification, Barangay, House No., Street 1, Postal Code, Geographical Coordinates and Sales Office.
   - Region, Province, Municipality, Distribution Channel and later fields, and Contact Person kept their values.
   - The first time, a similar partial wipe followed leaving the form with Back and reopening the restored draft.

   For the guide: tell agents to take the photo first, or to check every field again before tapping Save.
2. **Customer Address fills itself with "City of Cebu, Cebu"** once a Municipality is picked and the field is empty. If you clear the field, the text comes straight back, and anything you type is added to it ("…Cebu CityCity of Cebu, Cebu"). One time it also showed odd capitals ("Citycity Of Cebu").
3. **The saved store is named after the Customer Name (the owner), not the Registered Name.** Home "Last saved", the in-form "Saved customers" list and the server's pending outlet all show "Nena Reyes" and "Benjamin Cruz", not "Aling Nena Sari-Sari Store" or "Mang Ben Variety Store".
4. **The success dialog says "Store saved" / "Store saved — sent to the office for approval."** The rest of the screen says "customer". The dialog also closed by itself after about 2 s and left a new blank Add customer form instead of going back to Home. You must tap Back to see Home.
5. **The Customer Grp 1 options don't match the channel.** For Distribution Channel "General Trade (30)", the only Customer Grp 1 option is "Key Accounts 3 (KAS3)".
6. **The Customer Group list is long and has no obvious choice for a sari-sari store.** It holds 91 chain names (ABOHAN, GAISANO…, SM GROUP); a small store needs "NO GROUP (74)", which you can only find by typing in the search box.
7. **Barangay spelling.** Searching "Kamputhaw" finds nothing; the list spells it "Camputhaw". Agents may give up when a common spelling isn't found.
8. **The Customers tab in mapping mode shows route and visit items:** the "On today's route 25" filter and green "Done" visit chips on sample customers. The two newly mapped stores are not listed there, presumably because they are still pending approval. A mapping-only agent may expect to find them there.
9. **Location privacy.** The coordinates shown on the form are the phone's real GPS position. They are deliberately kept out of these screenshots.
