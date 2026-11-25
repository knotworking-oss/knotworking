# Connect Xero and post supplier bills

Knotworking sends approved supplier invoices to Xero as authorised bills. The optional Accounting module keeps the reviewed destination, financial lines and posting history in the [private accounting outbox](accounting.md#posting-lifecycle-and-isolation).

## Set up a test app and connect

1. In the [Xero Developer Portal](https://developer.xero.com/app/manage), create a **Web app** for acceptance. Choose a [Xero Demo Company](https://central.xero.com/s/article/Use-the-demo-company) with the intended base currency. Register this exact redirect URI, substituting your Knotworking web origin for `APP_URL`.

   ```text
   APP_URL/api/v1/accounting/xero/callback
   ```

   Use HTTPS. Xero permits `http://localhost` for local testing, with the actual port. For example, register `http://localhost:3000/api/v1/accounting/xero/callback` for that local web origin. The callback goes through the web gateway, so it can read the initiating browser session. Configure any reverse-proxy access logs to omit the callback query string. See the [Xero authorisation code flow](https://developer.xero.com/documentation/guides/oauth2/auth-flow/).

2. Set `XERO_CLIENT_ID`, `XERO_CLIENT_SECRET` and a private `BETTER_AUTH_SECRET` of at least 32 characters in the API environment. With Compose, use `deploy/.env`. Give all API workers the same values. Enable `accounting` and the workspace's required modules in `KNOTWORKING_MODULES`. Keep Items and Purchasing available to the people who review suppliers and bills. Enable Stock for stocked purchases. Apply the migrations and restart the API. Set `ACCOUNTING_DISPATCH_INTERVAL_SECONDS=0` during acceptance if you want to control the exact send using **Send now**.
3. In Knotworking, a signed-in workspace owner or admin with Accounting manage access opens **Accounting connections**, saves a Xero setup and selects **Connect Xero**. Sign in and authorise the Demo Company. The app requests `offline_access`, `accounting.invoices`, `accounting.settings.read` and `accounting.contacts.read`. See [Xero scopes](https://developer.xero.com/documentation/guides/oauth2/scopes/).
4. Return to the original browser session. Under **Authorised organisation**, select the Demo Company and choose **Review organisation**. Compare the displayed name, tenant ID and base currency with your intended ledger, then choose **Confirm organisation and currency**. The currency must match the workspace currency and use two decimal places. The workspace defaults to GBP, and changing its currency does not convert any values. Use **Verify connection** to check the saved organisation and currency.

The consent flow expires after ten minutes and the callback state is single-use. Tokens stay server-side and are encrypted with AES-256-GCM using a key derived from the private server secret and Xero client ID. Workers lock the credential row when exchanging a refresh token and persist the rotated pair together. If you change the server secret or Xero client ID, reconnect affected setups.

## Review mappings and send a bill

1. Open the connection's **Reviewed mappings**. In the selected Xero organisation, identify the existing supplier contact, active account codes and applicable tax types. Save a supplier mapping to the Xero `ContactID` (UUID), account mappings to Xero account codes, and tax mappings to Xero `TaxType` codes. Record what you reviewed in each mapping reason. Use the Xero API's [Contacts](https://developer.xero.com/documentation/api/accounting/contacts/), [Accounts](https://developer.xero.com/documentation/api/accounting/accounts/) and [TaxRates](https://developer.xero.com/documentation/api/accounting/taxrates/) resources to confirm the values.
2. Create and send a purchase order, record its receipt, create a matched purchase invoice with the supplier's invoice number, invoice date, due date and VAT, and approve it. A non-stock service can be received and matched without Stock. Under the connection, choose **Prepare approved invoices**, pick the invoice, check the destination and code every line. Confirm the line net and tax amounts printed on the invoice.
3. In **Accounting queue → Queued**, use **Send now**, or let the dispatcher send it. A prepared invoice keeps its original tenant and reviewed mappings. The adapter checks the confirmed organisation, currency, supplier contact, account codes and tax types before writing. It writes one `ACCPAY` bill with `AUTHORISED` status and exclusive amounts. Each reviewed financial line becomes a quantity-one line with the reviewed net and tax. Xero records the supplier's bill number and a URL to the source purchase invoice.
4. In **Posted**, open the result and record the Xero invoice ID. In Xero, compare the supplier, invoice number, dates, account and tax codes, net, tax and gross against the source, and follow the source link. Knotworking confirms the posting after reading the Xero bill back and comparing those fields. See the [Xero invoice contract](https://developer.xero.com/documentation/api/accounting/invoices/).

## Reconnect, disconnect and recover an interrupted posting

- **Reconnect required.** If Xero revokes access or the refresh grant expires, choose **Reconnect Xero** and confirm the original organisation. Use **Verify connection** before resuming work. Existing postings still refer to the original destination. A different organisation needs a different setup.
- **Pause or disconnect.** Disable a setup to pause preparation and sending while retaining access for read-back. **Disconnect Xero** removes the local credentials and tries to remove that tenant connection in Xero. If Xero could not confirm the removal, finish it in Xero's **Connected apps**. Existing posting history stays available. Reconnect the same organisation to resume.
- **Needs checking.** Open the original posting and enter a review note. Choose **Find and verify in Xero** to look up the original bill by its reviewed contact, invoice date and unique source link. You can also find the bill manually and enter the Xero invoice UUID to check directly. Search results must identify one matching bill and pass full read-back. If the result stays uncertain, review it in Xero before taking further action. An uncertain attempt is never resent by Knotworking.
- **Rejected.** Check the history for the reason. A retry uses the original snapshot, including its mappings and line values. Retry after fixing an external condition such as an inactive account or lost consent. Making a new mapping in settings does not change a prepared bill.

## Demo Company acceptance evidence

Automated tests use a fake Xero HTTP service. Record live results here when acceptance is run. Use synthetic suppliers and purchases. Keep OAuth credentials, tokens and callback URLs out of evidence.

| Check                             | Evidence to record                                                                                                                                                                                                | Result  |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| Setup and verification            | Date, tester, Knotworking commit, workspace, Xero Demo Company name and tenant ID, base currency and approval roles                                                                                               | Pending |
| Mapping review                    | Synthetic supplier and Xero ContactID, account codes, tax types and reviewer                                                                                                                                      | Pending |
| Stock purchase bill               | Purchase order, receipt, approved invoice and queue posting IDs, Xero invoice ID, net/tax/gross, source link and read-back history                                                                                | Pending |
| Service purchase bill             | Same evidence as the stock purchase, with Stock disabled and a non-stock receipt                                                                                                                                  | Pending |
| Interrupted response              | In a test environment, drop the client-side response after Xero commits one bill. Record the uncertain attempt, Xero invoice ID, recovery result and count of bills for the source link before and after recovery | Pending |
| Disable, disconnect and reconnect | Evidence that disabled and disconnected setups send no queued bills, and reconnection verifies the same tenant before sending resumes                                                                             | Pending |
| Exceptions                        | Any unexpected validation, rounding or permission behaviour and the person responsible for follow-up                                                                                                              | Pending |

### Open questions

- Confirm the pilot workspace and Xero organisation use the same base currency. The implementation uses the configured workspace currency, with GBP as the existing default.
- Confirm who approves supplier invoices and who reviews the accounting coding. This increment uses the existing single-approver Purchasing flow. The approver and the accounting reviewer may be the same person if their role grants both permissions.
