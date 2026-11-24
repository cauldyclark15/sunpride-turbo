# Completing submitted customer profiles (SP-0250)

This describes the implemented software behavior, not a new client approval policy or proof of publication.

## Access and status

- A Field submission stays provisional / waiting for approval when details are saved. Its customer number, enrollment, and original submitted copy are retained; saving never approves it or creates another customer.
- The submitting salesman and CDMs can complete a waiting customer. Existing office-editor rights remain available before approval. Salesmen cannot amend someone else's submission.
- A submitter may open their own waiting profile even if its territory has a different salesman. Current organizational scope still applies; this does not grant access to other people's customers.
- Approved customer profile edits require Admin or Super Admin. The same check is made by the canonical writer and older profile/change-request entry points. Customer-file uploads also refuse non-admin updates to approved customers.
- Office-created prospects still follow their existing complete-on-save rules. Incomplete submitted Field profiles can be filled in a few fields at a time; supplied values must still be valid. Approval continues to check all required fields.

## Where to open it

1. Website: Customers > New customers > open the customer profile.
2. Field Android and iOS: More > Submitted customers. Select a customer; use Search and Load more as needed. Switch to All to view approved customers.
3. A downloaded customer's detail screen also opens its profile.

The Field profile editor needs an internet connection. It intentionally does not reuse saved approval rights or queue an edit that could arrive after approval. Ordinary new-customer capture and its existing saved work are unchanged.

Missing fields are listed and marked beside the controls. Selecting a parent refreshes its dependent lists; changing a sales organization or channel clears incompatible selections, including ADP fields. Additional configured enrollment fields, existing ship-to entries, and photos are included. Save details keeps the customer waiting for approval. Check remaining fields refreshes the missing-field display without saving.

The change history records the person, time, field, previous value and new value in the same transaction as the save. Apps display the latest 50 entries and disclose when older entries exist. Photo contents are not printed in the displayed history. Original audit and enrollment records are retained.

## Focused QA

Use owned sample customers, not a real customer's details.

1. Submit an incomplete customer on a Field account and sync it.
2. Reopen it as the submitting salesman; fill one missing field and save. Reopen again and check that the value is retained, the customer number is unchanged, and it is still waiting for approval.
3. Open it as a CDM and complete another field. Check the history for both people and their old/new values.
4. A different salesman must not be able to save that profile.
5. Complete the required fields and approve it. The salesman and CDM should now see read-only fields; Admin and Super Admin may still edit it.
6. Keep a profile open on another account during approval and try to save its earlier form. It must not change the approved profile. Reopen it to see the current read-only state.
7. Confirm an admin can change the approved profile and that the latest history entry names the admin.

Automated evidence for this change uses isolated sample data and native request/model tests. It is not a production or physical-phone acceptance claim. The website, API, Android and iOS changes must be delivered together before staff try these steps on their usual devices.
