## 04. HubSpot lead intake: form identification, submissions API, forms list, CRM search

This section draws on several kinds of source. The official ones are HubSpot's public OpenAPI spec collection (full history up to commit 476fa1a, 2026-10-01) and HubSpot's own SDK sources (`hubspot-php`, `hubspot-api-nodejs`). The sandbox blocked developers.hubspot.com, knowledge.hubspot.com, legacydocs.hubspot.com, web.archive.org, postman.com and api.hubapi.com. Pages on HubSpot's docs hosts and forum are therefore cited through search summaries or through a verbatim third-party scrape of the official developer docs (teostereciu/mcpsynth, scraped 2026-04-13). Community raw dumps of HubSpot's Properties API are also used. Every citation is labelled with its kind. No official machine-readable spec exists for the form-submissions endpoint.

**Confirmed as the brief assumes:**
- The forms list is `GET /marketing/v3/forms`, scope `forms`.
- Contact reads and CRM search on `recent_conversion_date` work, scope `crm.objects.contacts.read`.
- All of these are available on HubSpot's Free tiers.

**The sources correct the brief in four places:**
1. **Contact properties cannot reliably identify the submitting form.** `recent_conversion_event_name` is a human-readable "Page title: Form name" string with no form GUID. The primary intake source must therefore be the legacy endpoint `GET /form-integrations/v1/submissions/forms/{formGuid}` (scope `forms`). It is still the only read path, and it has no official spec. The `contact.creation` webhook and the contacts search become triggers only.
2. **The poller rationale is not official.** The brief says "conversion-date properties are calculated, so they can't be webhook-subscribed". The official text excludes only `num_unique_conversion_events` and `hs_lastmodifieddate`. The real reason for polling is that HubSpot has no form-submission webhook event.
3. **Submissions carry no contact ID.** Dedupe on `(portalId, formGuid, conversionId)`, or on `(portalId, formGuid, submittedAt, lower(email))` when there is no `conversionId`, and resolve the contact by email.
4. **The §5.8 baseline needs email-engagement search.** No contact property measures it. One spec rollout requires `sales-email-read` for that search, which is outside the brief's scope set.

**The sources extend the brief with:**
- the contacts-search request format and limits: GTE with an overlap window, one ascending sort, epoch-ms strings, 200 results per page, a 10,000-result cap and 5 requests/s;
- the forms-list `formTypes` parameter (send `hubspot` and `flow`);
- a deterministic heuristic for detecting newsletter forms;
- a message-extraction order that prefers submission values over the `message` property, which each new submission overwrites;
- HubSpot's 2026 date-based path versioning: contacts and emails have dated paths, while forms and form submissions do not.

### HS-INTAKE-CONVERSION-PROPS — Conversion properties name the last and first form, but carry no form GUID
- **Brief:** §5.2 says "[VERIFY which properties or Forms API data identify the submitting form]". The poller relies on `recent_conversion_date`, and the brief notes that "conversion-date properties are calculated".
- **Resolves:** [VERIFY] §5.2 which properties or Forms API data identify the submitting form. This finding covers the contact-property half; HS-INTAKE-SUBMISSIONS-API covers the Forms API half.
- **Verdict:** Extended — medium confidence.
  - Internal names: high confidence, because they are in the official spec enum.
  - The `calculated` and read-only flags: these come only from community-hosted raw API dumps.
  - The "Page title: Form name" format: this comes from a search summary of a KB page.
- **Finding:** All seven properties are HubSpot default contact properties. Their internal names are verified against the official spec enum of 410 default contact property names.

  | Internal name | Label | Type | Meaning |
  |---|---|---|---|
  | `recent_conversion_event_name` | Recent Conversion | string (text) | Last form submitted. Value format `<Page title>: <Form name>` (KB). Contains **no form GUID**. |
  | `first_conversion_event_name` | First Conversion | string | First form submitted, in the same "Page title: Form name" format. |
  | `recent_conversion_date` | Recent Conversion Date | datetime | Date of the most recent form submission. |
  | `first_conversion_date` | First Conversion Date | datetime | Date of the first form submission. |
  | `num_conversion_events` | Number of Form Submissions | number | Total form submissions. |
  | `num_unique_conversion_events` | Number of Unique Forms Submitted | number | Distinct forms. Per the KB, this counts HubSpot forms, pop-up forms and collected (non-HubSpot) forms. |
  | `hs_calculated_form_submissions` | The 800 most recent form submissions for a contact | enumeration (hidden) | See HS-INTAKE-CALC-FORM-SUBMISSIONS. |

  **Flags and update behaviour:**
  - All seven are `calculated: true` with `modificationMetadata.readOnlyValue: true`, per raw Properties API dumps.
  - HubSpot's backend sets them when it processes a submission. New **and** repeat submissions both update the `recent_*` and `num_*` properties.

  **Reading them:**
  - All are readable with `crm.objects.contacts.read`, via `GET /crm/v3/objects/contacts/{id}?properties=...` or the search `properties` array.
  - Hidden properties must be requested explicitly. By default, v3 returns only `firstname`, `lastname` and `email`.

  **How v3 serialises values:**
  - Every property value is a string.
  - A datetime is an ISO-8601 UTC string, e.g. `'2019-10-30T03:30:17.883Z'` (the spec example for `createdate`).
  - A number is a decimal string, e.g. `'3'`.
  - A missing value is `null` or absent.
  - Verifier caveat: the generic properties example in the 107729/v3 spec shows `"property_date": "1572480000000"` (a millisecond string), and legacy v1 returns millisecond strings. Accepting both formats is therefore necessary, not optional.

  **Verifier caveat on the name format:** the page-title prefix is not always present. The official legacy v1 contact-profile example shows `recent_conversion_event_name` as `"Contact Us: excedalogic form"` but `first_conversion_event_name` as `"excedalogic form"`.

  **Runtime check:** `GET /crm/v3/properties/contacts/{name}` returns the fields `calculated` and `modificationMetadata.readOnlyValue`.
- **Design consequence:**
  - Never identify the submitting form from `recent_conversion_event_name`. The value is human-readable and ambiguous, it breaks when a form or page is renamed, page titles can contain colons, and the prefix is not always present.
  - Identify the form by GUID through the Forms submissions API, keyed by the selected form GUIDs.
  - Use `recent_conversion_date` only as a cheap "something changed" signal, and as a cross-check (`submittedAt` ≈ `recent_conversion_date`).
  - In Zod, treat every property value as `string | null`. Parse ISO dates, and also accept numeric millisecond strings.
  - Request properties explicitly: `email, firstname, lastname, company, message, recent_conversion_date, recent_conversion_event_name, num_conversion_events, hs_email_optout`. (`hs_email_optout` is listed for the §5.6 stop rule; this section does not verify it.)
- **Open risk:**
  - Calculated properties are computed asynchronously. When a `contact.creation` webhook arrives, the conversion properties may not be populated yet, so re-read the contact or defer to the poller.
  - `recent_conversion_*` and `num_unique_conversion_events` also change for pop-up and collected (non-HubSpot) forms. A change does not mean a selected form was submitted.
  - At WIRE_UP, re-check live:
    - the `calculated` and `readOnlyValue` flags (community dumps only), using `GET /crm/v3/properties/contacts/{name}`;
    - the "Page title: Form name" format (KB search summary only);
    - which datetime serialisation the live API returns.
- **Sources:**
  - https://github.com/HubSpot/HubSpot-public-api-spec-collection/blob/main/PublicApiSpecs/Conversations/Custom%20Channels/Rollouts/160898/v3/customChannels.json — official OpenAPI spec — "components.schemas.PreResolvedContact.contactPropertiesLeadingToMatch.items.enum (410 default contact property internal names) includes ... "first_conversion_date", "first_conversion_event_name", ... "hs_calculated_form_submissions", ... "num_conversion_events", "num_unique_conversion_events", "recent_conversion_date", "recent_conversion_event_name""
  - https://github.com/HubSpot/HubSpot-public-api-spec-collection/blob/main/PublicApiSpecs/CRM/Properties/Rollouts/145899/v3/properties.json — official OpenAPI spec — "Property.calculated: "For default properties, true indicates that the property is calculated by a HubSpot process. It has no effect for custom properties."; PropertyModificationMetadata.readOnlyValue: "Indicates whether the property's value is read-only and cannot be modified."; GET /crm/v3/properties/{objectType}/{propertyName} accepts (any-of) scopes incl. crm.objects.contacts.read and crm.schemas.contacts.read"
  - https://github.com/HubSpot/HubSpot-public-api-spec-collection/blob/main/PublicApiSpecs/CRM/Contacts/Rollouts/107729/v3/contacts.json — official OpenAPI spec — "POST /crm/v3/objects/contacts/search security [{"oauth2": ["crm.objects.contacts.read"]}, ...]; SimplePublicObject example properties "createdate": "2019-10-30T03:30:17.883Z"" and "SimplePublicObject.properties example: {"property_date": "1572480000000", "property_number": "17", ...}; additionalProperties {type: string, nullable: true}"
  - https://knowledge.hubspot.com/properties/hubspots-default-contact-properties — official page via search summary — direct fetch blocked in sandbox — "Recent conversion = last form submitted, formatted as the name of the page the form was submitted on, followed by a colon, then the name of the submitted form ('Page title: Name of form') ... Number of unique forms submitted counts HubSpot forms, pop-up forms, and collected forms." (summary, not verbatim)
  - https://github.com/Tracardi/tracardi/blob/master/tracardi/process_engine/action/v1/connectors/hubspot/properties.json — community, non-authoritative (raw dump of `GET /crm/v3/properties/contacts`) — "{"name": "recent_conversion_date", "label": "Recent Conversion Date", "description": "The date this contact last submitted a form", "type": "datetime", "fieldType": "date", "calculated": true, "modificationMetadata": {"archivable": true, "readOnlyDefinition": true, "readOnlyValue": true}}; ... hs_calculated_form_submissions "A set of all form submissions for a contact" enumeration hidden true calculated true"
  - https://github.com/pulumi/pulumi-hubspot/blob/master/src/hubspot/contact_properties/conversioninformation/index.ts — community, non-authoritative — "recent_conversion_event_name label "Recent Conversion" description "The last form this contact submitted" calculated: true; first_conversion_event_name "The first form this contact submitted" calculated: true"
  - https://github.com/teostereciu/mcpsynth/blob/main/benchmark/datasets/hubspot/docs/api_v1_get-contacts-v1-contactutkcontactutk-profile.md — community, non-authoritative (verbatim scrape of the official legacy Contacts v1 profile page) — ""recent_conversion_event_name": { "value": "Contact Us: excedalogic form" } ... "first_conversion_event_name": { "value": "excedalogic form" } ... "recent_conversion_date": { "value": "1484915989198" }"

### HS-INTAKE-CALC-FORM-SUBMISSIONS — `hs_calculated_form_submissions` carries form GUIDs, but in an undocumented format
- **Brief:** not addressed.
- **Resolves:** [VERIFY] §5.2 which properties or Forms API data identify the submitting form. This is a secondary, undocumented signal only.
- **Verdict:** Not officially documented — low confidence. Only the property's existence is official; its value format comes from community sources.
- **Finding:**
  - **Official:** the property exists; its internal name is in the official spec enum.
  - **Metadata (from community property dumps):** `hidden: true`, type `enumeration`, `calculated: true`, `readOnlyValue: true`. The description is 'A set of all form submissions for a contact', and the newer label is 'The 800 most recent form submissions for a contact'.
  - **Value format:** NOT officially documented. Community evidence says it is semicolon-separated entries, each `<formGuid>:<pageId>:<timestampMs>`. `pageId` may be empty, giving `<formGuid>::<timestampMs>`.
  - So the property does carry a form GUID and a timestamp for each submission (up to 800), but only in an undocumented internal format.
  - Verifier: the 3-part structure rests only on a community search summary that could not be re-run. The devslack quote fits entries containing `::` but does not prove the order of the parts.
- **Design consequence:** Use it as an optional secondary signal only, never as the sole source of truth; the Forms submissions API stays primary.
  - Parse defensively: split on `;`, then on `:`, giving `[guid, pageId, ts]`. Validate the GUID with a regex and the timestamp as a 13-digit millisecond value.
  - Keep the parser behind `HubSpotClient` so it can be dropped.
- **Open risk:**
  - The undocumented internal format can change without notice.
  - The ordering of entries is unknown.
  - The property must be requested explicitly, because it is hidden.
  - With an 800-entry cap the value can be long, and its truncation and ordering are unknown.
  - If it is used at all, read it live on a test contact during WIRE_UP before relying on the parser.
- **Sources:**
  - https://github.com/HubSpot/HubSpot-public-api-spec-collection/blob/main/PublicApiSpecs/Conversations/Custom%20Channels/Rollouts/160898/v3/customChannels.json — official OpenAPI spec — "PreResolvedContact.contactPropertiesLeadingToMatch enum includes "hs_calculated_form_submissions""
  - https://github.com/therealnaveennb/demo/blob/main/hubspot_properties.txt — community, non-authoritative — "hs_calculated_form_submissions,The 800 most recent form submissions for a contact,enumeration,select,contactinformation"
  - https://github.com/hubspotdev/devslackarchive/blob/main/channel_data-driven-content/2023/02/2023-02-22.json — community, non-authoritative — ""I think the property hs_calculated_form_submissions will do it" ... "you just need to split by the ; and then remove everything after the ::""
  - https://community.hubspot.com/t/missing-properties-for-contact-form-submissions-in-v3/62797 — community, non-authoritative (via search summary) — "colon-delimited format {form_id}:{?}:{timestamp}; 'The second ID in this property is actually the ID of the page where the submission was made from'; available from the CRM v3 contacts endpoint."

### HS-INTAKE-SUBMISSIONS-API — The legacy `GET /form-integrations/v1/submissions/forms/{formGuid}` is the only read path for submissions
- **Brief:** §5.2 Message extraction says "get the lead's message and name fields from the form submission [VERIFY Forms submissions endpoint and scope]". §5.8 builds the baseline from the last 30 days of leads.
- **Resolves:** [VERIFY] §5.2 Forms submissions endpoint and scope. It also resolves the Forms API half of [VERIFY] §5.2 which properties or Forms API data identify the submitting form.
- **Verdict:** Not officially documented in any source reachable here — medium confidence.
  - **Officially backed:** HubSpot's own PHP SDK confirms the path. A full-history scan of the official spec collection, plus the official Node SDK, confirms that no newer replacement exists.
  - **Not officially backed:** the scope `forms`, the page-size limits, the sort order and the field names rest on a search summary of the official legacy reference page plus the community Airbyte connector.
  - The verifier downgraded the research verdict from "confirmed".
- **Finding:**
  - **Endpoint:** `GET https://api.hubapi.com/form-integrations/v1/submissions/forms/{formGuid}`. It is legacy, but it is still the only official read path for form submissions.
    - `formGuid` is the `id` returned by `GET /marketing/v3/forms`.
    - Evidence for the path: HubSpot-owned `hubspot/hubspot-php` (`Forms::getSubmissions`) and the Airbyte connector.
  - **No replacement exists.** There is no v3, date-versioned or beta replacement:
    - The official spec collection has never contained a form-submissions spec in its full history (660,021 commits, from 2023-08-18 to HEAD 476fa1a on 2026-10-01).
    - It has no `form-integrations` or `extensions/forms` path at all.
    - The official Node SDK `FormsApi` has only `archive`, `create`, `getById`, `getPage`, `replace` and `update`.
  - **Scope:** `forms`. The only direct evidence is community (Airbyte `required_scopes: forms`). It is plausible because every Forms API operation in the official spec uses `forms`.
  - **Query parameters** (from the docs search summary and Airbyte; not officially verifiable here):
    - `limit`: default 20, max 50;
    - `after`: the cursor from `paging.next.after`.
  - **Response** (same caveat):
    ```text
    {"results":[{"conversionId"?:string, "submittedAt":<epoch ms number>, "values":[{"name":string,"value":string,"objectTypeId"?:string e.g. "0-1"}], "pageUrl"?:string}], "paging"?:{"next":{"after":string,"link"?:string}}}
    ```
  - **Order:** reported as newest-first ("Submissions are returned in reverse-chronological order"). This comes from a search summary only.
  - **What the endpoint does not offer:**
    - no server-side time filter;
    - no contact ID in the payload;
    - no documented retention limit.

    `conversionId` is reported as not always returned.
  - The Airbyte connector (community) notes that the `blog_comment` and `all` form types are "Not supported by `v1` api version used by the FormSubmissions stream".
  - **Defensive polling rule:**
    1. Request `limit=50` and follow `paging.next.after`.
    2. Stop when a page contains NO submission with `submittedAt > (formCursor - overlap)`, or when `paging.next` is absent.
    3. Cap the pages per poll (e.g. 20 pages = 1,000 submissions), and raise a Sentry warning if the cap is hit.
    4. Dedupe on `(portalId, formGuid, conversionId)` when `conversionId` is present, else on `(portalId, formGuid, submittedAt, lower(email))`.

    If the API turns out to be oldest-first, this rule still terminates correctly through the cap and the dedupe. The poller must not depend only on the newest-first claim.
  - Validate the default page size, max page size, order and scope in the WIRE_UP smoke test before relying on them.
  - Keep the submissions client behind `HubSpotClient`, so it can be swapped if HubSpot sunsets the legacy endpoint.
  - **Dropped claim:** an earlier draft said the endpoint is "not part of the /forms/v1 sunset". Nothing supports that, so it is dropped.
- **Design consequence:** Make this endpoint the PRIMARY intake source for selected forms. On each poll, for each selected form GUID, call `GET ?limit=50` and iterate pages while `submittedAt > (formCursor - overlap)`.
  - This captures repeat submissions and multiple submissions between polls, and gives the lead's message and name directly from `values[]`.
  - Zod: `conversionId` optional, `pageUrl` optional, `values[].objectTypeId` optional, `submittedAt` a number.
  - Calls per poll = the number of selected forms (plus extra pages), well within 110 requests/10 s per account.
  - The fake `HubSpotClient` must model newest-first order and 50-item pages.
- **Open risk:**
  - HubSpot could sunset the legacy endpoint with notice, so watch the changelog. §02 HS-API-VERSIONING records that v1–v3 APIs become unsupported, with enforcement in September 2027.
  - The docs host was blocked, so the default of 20, the max of 50 and the order come from search summaries and connectors, not from a verbatim page.
  - `conversionId` is reported as sometimes missing.
  - Behaviour for pop-up (`flow`) and collected (`captured`) forms is not officially stated.
  - The WIRE_UP smoke test must confirm:
    - that `forms` is sufficient;
    - the `limit` default and maximum;
    - newest-first order;
    - the field names `conversionId`, `submittedAt`, `values[{name,value,objectTypeId}]` and `pageUrl`;
    - behaviour on `flow` forms;
    - availability on a Free portal.
- **Sources:**
  - https://developers.hubspot.com/docs/api-reference/legacy/forms-v1/submissions/get-form-integrations-v1-submissions-forms-form_guid — official page via search summary — direct fetch blocked in sandbox — "GET https://api.hubapi.com/form-integrations/v1/submissions/forms/{form_guid}; 'limit (integer, default: 20): The number of results to include in the response, with a maximum of 50'; 'after (string): Used to get the next page of results'; ... 'Submissions are returned in reverse-chronological order'; values have name, value, objectTypeId; reports that conversionId is not always returned."
  - https://developers.hubspot.com/changelog/2019-01-23-new-feature-get-the-submissions-for-a-hubspot-form — official page via search summary — direct fetch blocked in sandbox — "endpoint gets details for individual submissions for a HubSpot form, including all fields, the time submitted and the page submitted on."
  - https://github.com/HubSpot/hubspot-php/blob/master/src/Endpoints/Forms.php — official SDK source (re-fetched from raw.githubusercontent.com, HTTP 200, repo HEAD 2d37f7e, 2025-06-26) — "* Get all submissions from a form. * @see https://developers.hubspot.com/docs/methods/forms/get-submissions-for-a-form ... public function getSubmissions($form_guid, array $params = []) { $endpoint = "https://api.hubapi.com/form-integrations/v1/submissions/forms/{$form_guid}";" (query params are passed through unvalidated, so the SDK documents no limit, default or order)
  - https://github.com/HubSpot/HubSpot-public-api-spec-collection/tree/main/PublicApiSpecs — official OpenAPI spec — "Commit 476fa1a767c9aa36d5b13e3e54c99f2846cc72d6 (2026-10-01): grep of all spec files finds no 'form-integrations' string and no forms submissions or 'extensions/forms' path; only submission paths are feedback_submissions and forecast-submissions."
  - https://github.com/HubSpot/HubSpot-public-api-spec-collection — local experiment — "Bare blob-less clone of the full history (660,021 commits, oldest 2023-08-18, HEAD 476fa1a 2026-10-01). Ran `git log --diff-filter=A --name-only HEAD | grep -i -E 'form|submiss|integration'`. ... No form-integrations or forms-submissions spec has ever existed in the collection."
  - https://github.com/HubSpot/hubspot-api-nodejs/blob/master/codegen/marketing/forms/apis/FormsApi.ts — official SDK source — "Only methods: archive(formId) [doc: 'Archive a form definition. New submissions will not be accepted and the form definition will be permanently deleted after 3 months.'], create, getById, getPage(after?, limit?, archived?, formTypes?), replace, update. All paths are '/marketing/v3/forms/...'. No submissions method."
  - https://github.com/airbytehq/airbyte/blob/master/airbyte-integrations/connectors/source-hubspot/manifest.yaml — community, non-authoritative — "form_submissions_stream: required_scopes: forms; path: "/form-integrations/v1/submissions/forms/{{ stream_partition['form_id'][0] }}"; parent forms_stream path: /marketing/v3/forms, parent_key: "id"; page_size: 50; cursor from paging.next.after; schema conversionId, submittedAt, values[{name,value,objectTypeId}], pageUrl; comment '# Not supported by `v1` api version used by the FormSubmissions stream' for blog_comment/all"

### HS-INTAKE-SUBMISSION-CONTACT-MATCH — Submissions carry no contact ID, so resolve the contact by email
- **Brief:** §5.2: "Deduplicate on (contact ID, submission timestamp)."
- **Verdict:** Extended — medium confidence.
- **Finding:**
  - **Lookup:**
    1. Take the `values[]` entry with `name == 'email'` (`objectTypeId` `'0-1'`) and lower-case it.
    2. Call `GET /crm/v3/objects/contacts/{email}?idProperty=email&properties=firstname,lastname,company,email,message,recent_conversion_date,hs_email_optout`.

    The spec says: 'Retrieve a contact by its ID (`contactId`) or by a unique property (`idProperty`)'. The official contacts guide gives the dated form: `GET /crm/objects/2026-03/contacts/{email}?idProperty=email`.
  - **Cross-check:** `contact.recent_conversion_date >= submittedAt`. The two are equal for the latest submission; allow a small tolerance. Verifier: that equality is an unverified assumption, so use the check only as a soft consistency check, never as a gate.
  - **Submission history on the contact:** `propertiesWithHistory=message,recent_conversion_date` returns `ValueWithTimestamp[]` `{value, timestamp, sourceType, sourceId, sourceLabel, updatedByUserId}`. The spec does not enumerate the `sourceType` and `sourceId` values for forms.
- **Design consequence:**
  - Key leads on `(portal, formGuid, submission key)`, and resolve `contactId` after the lookup. Keep the brief's `(contactId, submittedAt)` as a secondary unique index.
  - The email lookup can 404 because of index lag, or because no contact was created (e.g. `createNewContactForNewEmail=false`). In that case, retry on the next poll and then surface the submission as 'unmatched'. Never guess.
- **Open risk:**
  - HubSpot may merge or deduplicate contacts, which changes the email key.
  - A lookup by email resolves the contact's primary email. No reachable source documents the behaviour when the submitted email is a secondary email, or after a merge.
  - Submissions without an email field cannot be matched.
  - At WIRE_UP, confirm the email lookup on a fresh test submission.
- **Sources:**
  - https://github.com/HubSpot/HubSpot-public-api-spec-collection/blob/main/PublicApiSpecs/CRM/Contacts/Rollouts/424/v3/contacts.json — official OpenAPI spec — "GET /crm/v3/objects/contacts/{contactId}: "Retrieve a contact by its ID (`contactId`) or by a unique property (`idProperty`)."; idProperty "The name of a property whose values are unique for this object type"; propertiesWithHistory "A comma separated list of the properties to be returned along with their history of previous values."; ValueWithTimestamp {value, timestamp, sourceType, sourceId, sourceLabel, updatedByUserId}"
  - https://github.com/airbytehq/airbyte/blob/master/airbyte-integrations/connectors/source-hubspot/manifest.yaml — community, non-authoritative — "form_submissions schema: values[{name, value, objectTypeId}] - no contact id field"
  - https://github.com/teostereciu/mcpsynth/blob/main/benchmark/datasets/hubspot/docs/api_contacts_guide_2.md — community, non-authoritative (verbatim scrape of the official contacts guide, https://developers.hubspot.com/docs/api-reference/latest/crm/objects/contacts/guide) — "'You can retrieve individual contacts using the contact's Record ID value or their email address.' / 'To retrieve a contact by their email address, make a `GET` request to `/crm/objects/2026-03/contacts/{email}?idProperty=email`.'"

### HS-ONBOARD-FORMS-LIST — `GET /marketing/v3/forms` (scope `forms`) lists the forms for onboarding and settings
- **Brief:** §4 step 2.3: "The list is fetched from HubSpot". §5.1 lists the scope `forms`. §5.11 has forms in Settings.
- **Resolves:** [VERIFY] §5.1 minimum scopes, for the `forms` scope on the forms list.
- **Verdict:** Confirmed — high confidence.
- **Finding:**
  - **Endpoint:** `GET https://api.hubapi.com/marketing/v3/forms`, scope `forms` (spec security `[{"oauth2":["forms"]}]`). It has BETA twins, `/marketing/forms/2026-09-beta` and `/marketing/forms/2027-03-beta`, with the same parameters and scope.
  - **Query parameters:**
    - `after` (cursor).
    - `limit` (int32). The spec does not state a maximum; Airbyte uses 100.
    - `archived` (boolean, 'Whether to return only results that have been archived.'). Omit it or set it to false for live forms.
    - `formTypes` (array; repeat the key, e.g. `formTypes=hubspot&formTypes=flow`). Enum: `hubspot|captured|flow|blog_comment|all`. The official Postman collection confirms the repeated-key encoding.
  - **Unsourced defaults:** the defaults "returns `hubspot` forms only" and "page size 20" are reported, but the verifier found no cited source for either. Always send `formTypes` and `limit` explicitly.
  - **Response:** `{results:[HubSpotFormDefinition], paging:{next:{after,link}}}`.
  - **`HubSpotFormDefinition`:**
    - Required fields: `archived, configuration, createdAt, displayOptions, fieldGroups, formType, id, legalConsentOptions, name, updatedAt`.
    - `id` is the form GUID.
    - `formType` is `'hubspot'`.
    - `archivedAt` is optional.
    - `fieldGroups[{groupType default_group|progressive|queued, richTextType, richText?, fields[{name, label, fieldType, objectTypeId ('0-1' contact), required, hidden, ...}]}]`
    - `configuration{createNewContactForNewEmail, lifecycleStages[{objectTypeId,value}], language, postSubmitAction, notifyRecipients, ...}`
    - `displayOptions{submitButtonText, theme, ...}`
    - `legalConsentOptions` is oneOf:
      - `{type:'none'}`
      - `{type:'legitimate_interest', subscriptionTypeIds[], lawfulBasis, privacyText}`
      - `{type:'explicit_consent_to_process', communicationsCheckboxes[{subscriptionTypeId,label,required}], ...}`
      - `{type:'implicit_consent_to_process', communicationsCheckboxes[], ...}`
  - **`fieldType` values (13):** `email, phone, mobile_phone, single_line_text, multi_line_text, number, single_checkbox, multiple_checkboxes, dropdown, radio, datepicker, file, payment_link_radio`.
- **Design consequence:**
  - Fetch with `formTypes=hubspot&formTypes=flow`, because pop-ups can be lead forms, and with `archived=false`.
  - Page through `paging.next.after` with `limit=100`.
  - The response schema documents only `formType` `'hubspot'`, so the Zod schema should use passthrough or optional fields for other types.
  - Persist the selected form GUID together with a snapshot of its name.
  - Never use the `*-beta` paths in production.
- **Open risk:**
  - The maximum `limit` is undocumented (use 100 and follow cursors).
  - The shapes for non-`'hubspot'` form types are undocumented.
  - At WIRE_UP, confirm that `limit=100` is accepted and check what `flow` forms return.
- **Sources:**
  - https://github.com/HubSpot/HubSpot-public-api-spec-collection/blob/main/PublicApiSpecs/Marketing/Forms/Rollouts/144909/v3/forms.json — official OpenAPI spec — "GET /marketing/v3/forms parameters after(string), archived(boolean), formTypes(array, explode=true, enum ["hubspot","captured","flow","blog_comment","all"]), limit(int32); security [{"oauth2":["forms"]}]; 200 -> CollectionResponseFormDefinitionBaseForwardPaging {results[], paging.next.after}" and "HubSpotFormDefinition required [archived, configuration, createdAt, displayOptions, fieldGroups, formType, id, legalConsentOptions, name, updatedAt]; formType enum ["hubspot"]; field.objectTypeId "For example a CONTACT field will have the object type ID 0-1."; legalConsentOptions oneOf none|legitimate_interest|explicit_consent_to_process|implicit_consent_to_process"
  - https://github.com/HubSpot/HubSpot-public-api-spec-collection/blob/main/PublicApiSpecs/Marketing/Forms/Rollouts/144909/2026-09-beta/forms.json — official OpenAPI spec — "limit "The maximum number of results to display per page."; archived "Whether to return only results that have been archived."; after "The paging cursor token of the last successfully read resource will be returned as the `paging.next.after` JSON property of a paged response containing more results.""
  - https://github.com/HubSpot/hubspot-api-nodejs/blob/master/codegen/marketing/forms/apis/FormsApi.ts — official SDK source — "@param formTypes The form types to be included in the results. public async getPage(after?: string, limit?: number, archived?: boolean, formTypes?: Array<'hubspot' | 'captured' | 'flow' | 'blog_comment' | 'all'>"
  - https://github.com/HubSpot/HubSpot-public-api-spec-collection/blob/main/PublicApiSpecs/Marketing/Forms/Rollouts/144909/v3/Collection%20Directory_Marketing%20Forms%20API/Marketing%20-%20Forms%20API%20Collection.json — official OpenAPI spec (Postman collection) — "Postman item 'Get a list of forms' GET {{baseUrl}}/marketing/v3/forms/?after=<string>&limit=<integer>&archived=<boolean>&formTypes=captured&formTypes=all"
  - https://github.com/airbytehq/airbyte/blob/master/airbyte-integrations/connectors/source-hubspot/manifest.yaml — community, non-authoritative — "forms_stream path: /marketing/v3/forms, formTypes "['hubspot', 'captured', 'flow']", required_scopes: forms, page_size: 100"

### HS-ONBOARD-NEWSLETTER-DETECT — No newsletter flag exists; detect newsletter forms with a heuristic
- **Brief:** §4 step 2.3: "newsletter-style forms are unticked by default where detectable".
- **Verdict:** Extended — medium confidence. HubSpot has no official flag, so this is a heuristic. Every field it uses exists in the official v3 schema.
- **Finding:** There is no explicit 'newsletter' flag. These deterministic signals come from the v3 form definition:
  - **(a)** The only visible (`hidden=false`) fields are `email`, optionally with `firstname`/`lastname`. There is no `multi_line_text` field and no field named `message`.
  - **(b)** `configuration.lifecycleStages[].value == 'subscriber'`.
  - **(c)** `legalConsentOptions` has `communicationsCheckboxes` / `subscriptionTypeIds` (a subscription opt-in), together with (a).
  - **(d)** `name` or `displayOptions.submitButtonText` matches `/newsletter|subscribe|blog|updates/i`.
  - **(e)** `formType` is `'blog_comment'`. Exclude these entirely.

  Treat (a) or (b) as sufficient to untick a form, and (c) or (d) as supporting only.

  Verifier notes:
  - Count fields across **all** `fieldGroups`, because fields in `groupType` `progressive` or `queued` groups may stay hidden until a later visit.
  - Explicit and implicit consent forms **always** carry `communicationsCheckboxes` when consent is configured, including contact forms. That is why (c) must stay supporting-only.
- **Design consequence:**
  - Implement this as a pure, unit-tested `isLikelyNewsletter(formDef)` with golden cases. The owner can always re-tick a form.
  - Simulation fixture: one newsletter form with only an email field and lifecycle stage `'subscriber'`.
- **Open risk:** This is a heuristic, so false positives and false negatives are possible (e.g. a contact form without a message field). There is nothing to verify live beyond spot-checking real forms at WIRE_UP.
- **Sources:**
  - https://github.com/HubSpot/HubSpot-public-api-spec-collection/blob/main/PublicApiSpecs/Marketing/Forms/Rollouts/144909/v3/forms.json — official OpenAPI spec — "FieldGroup.fields oneOf EmailField|...|MultiLineTextField (fieldType 'multi_line_text')|...; field.hidden "Whether a field should be hidden or not."; configuration.lifecycleStages[{objectTypeId,value}]; legalConsentOptions explicit_consent_to_process.communicationsCheckboxes[{subscriptionTypeId}] / legitimate_interest.subscriptionTypeIds[]; displayOptions.submitButtonText" and "LifecycleStage.value "The internal name of the contact's lifecycle stage set when submitting a form"; displayOptions.submitButtonText "The text displayed on the form submit button.""

### HS-INTAKE-SEARCH-RECENT-CONVERSION — Contacts search on `recent_conversion_date` is supported; use it as a trigger only
- **Brief:** §5.2 Poller: "Search contacts whose `recent_conversion_date` is newer than the portal's cursor **[VERIFY search support]**."
- **Resolves:** [VERIFY] §5.2 search support.
- **Verdict:** Confirmed — high confidence. The limits come from the official spec, and the guide claims are corroborated by a verbatim scrape of the official search guide (last modified 2026-03-30).
- **Finding:** Search on `recent_conversion_date` is supported.
  - **Endpoint:** `POST https://api.hubapi.com/crm/v3/objects/contacts/search`, scope `crm.objects.contacts.read`. Its dated twin is `/crm/objects/2026-03/contacts/search`.
  - **Body:**
    ```json
    {"filterGroups":[{"filters":[{"propertyName":"recent_conversion_date","operator":"GTE","value":"<cursorMs>"}]}],"sorts":[{"propertyName":"recent_conversion_date","direction":"ASCENDING"}],"properties":["email","recent_conversion_date","recent_conversion_event_name"],"limit":200,"after":"0"}
    ```
  - **Filters:**
    - Operators include `GT`, `GTE` and `BETWEEN`. The full enum is `BETWEEN, CONTAINS_TOKEN, EQ, GT, GTE, HAS_PROPERTY, IN, LT, LTE, NEQ, NOT_CONTAINS_TOKEN, NOT_HAS_PROPERTY, NOT_IN`.
    - The filter value is a string: epoch milliseconds (UTC) or ISO-8601. Verifier caveat: the verbatim guide never says ISO-8601 is accepted, and its only datetime example uses epoch-ms strings (`"1579514400000"`). Send epoch ms as a string.
  - **Sorting:** only ONE sort is honoured; `direction` is `ASCENDING|DESCENDING`.
  - **Paging:**
    - `limit` maximum is 200; the default is 10.
    - The response is `{total, results[], paging.next.after}`.
  - **Hard cap:** 10,000 total results per query. Paging beyond that returns HTTP 400.
  - **Rate limit:** 5 requests/second per account, separate from the 110 requests/10 s app limit. The spec marks search with `x-hubspot-rate-limit-exemptions: [ten-secondly]`.
    - A search 429 carries the message `'You have reached your secondly limit.'`.
    - General 429s carry `policyName` `'TEN_SECONDLY_ROLLING'`.
  - **Filter limits:** the sources disagree. Use one group with at most 3 filters, which fits all three.

    | Source | Limit |
    |---|---|
    | docs | at most 5 `filterGroups` × 6 filters, 18 filters in total |
    | spec | 'Up to 6 groups' |
    | Node SDK README | 3 × 3 |
  - **Index latency:** 'It may take a few moments for newly created or updated CRM objects to appear in search results'. This is typically seconds, but it is unbounded.
  - **Repeat submission by an existing contact:** `recent_conversion_date` is 'the date this contact last submitted a form', so it advances on every submission, and `num_conversion_events` increments. `lastmodifieddate` ('The date any property on this contact was modified') therefore also advances.
  - **Verifier refinements:**
    1. Send epoch ms, not ISO.
    2. `after` must be the integer-formatted string from `paging.next.after` ('You must format the value in the `after` parameter as an integer'). Never synthesise cursors.
    3. The official spec and Node SDK type `sorts` as `Array<string>`. The guide uses `{"propertyName","direction"}` objects, and the SDK README documents both forms (`"-createdate"` = DESC). The object form is fine.
    4. Archived contacts never appear in search.
    5. The current docs present the path as `/crm/objects/2026-03/{object}/search`; the v3 guide now sits under `/docs/api-reference/legacy/` (see HS-API-VERSIONING-PATHS).
- **Design consequence:** Search is purely a trigger; confirm the form through the submissions API.
  - **Cursor:** use GTE from `cursor − overlap` (e.g. 15 min), plus dedupe, instead of a strict GT. Index lag can surface a contact whose `recent_conversion_date` is older than the maximum already seen. Persist `cursor = max(recent_conversion_date)` seen, but always query from `cursor − overlap`.
  - **10,000-result cap:** if `total >= 10,000`, re-anchor at the last returned value and restart paging. The ascending sort makes this safe.
  - **Rate:** throttle search to at most 4 requests/s per portal. On a 429 with the secondly message, back off 1 s. A 429 is transient per §5.1.
- **Open risk:**
  - Search exposes only the latest conversion per contact, so two submissions between polls collapse into one. This is another reason to use the submissions API as the source of truth.
  - No official source bounds the index latency.
  - The claim that a repeat submission advances `recent_conversion_date` and `lastmodifieddate` is an inference from property descriptions.
  - At WIRE_UP, re-check live:
    - that a repeat submission by an existing contact advances `recent_conversion_date` and appears in the search;
    - that epoch-ms string filters work.
- **Sources:**
  - https://github.com/HubSpot/HubSpot-public-api-spec-collection/blob/main/PublicApiSpecs/CRM/Contacts/Rollouts/424/v3/contacts.json — official OpenAPI spec — "PublicObjectSearchRequest: limit "The maximum results to return, up to 200 objects."; filterGroups "Up to 6 groups of filters defining additional query criteria."; query "The search query string, up to 3000 characters."; Filter.operator enum [BETWEEN, CONTAINS_TOKEN, EQ, GT, GTE, HAS_PROPERTY, IN, LT, LTE, NEQ, NOT_CONTAINS_TOKEN, NOT_HAS_PROPERTY, NOT_IN]; "x-hubspot-rate-limit-exemptions": ["ten-secondly"]"
  - https://github.com/HubSpot/HubSpot-public-api-spec-collection/blob/main/PublicApiSpecs/CRM/Contacts/Rollouts/107729/v3/contacts.json — official OpenAPI spec — "search security [{"oauth2": ["crm.objects.contacts.read"]}]; CollectionResponseWithTotalSimplePublicObjectForwardPaging required [results, total]"
  - https://developers.hubspot.com/docs/api-reference/search/guide — official page via search summary — direct fetch blocked in sandbox — "'The search endpoints are limited to 10,000 total results for any given query. Attempting to page beyond 10,000 will result in a 400 error.'; 'The search endpoints are rate limited to five requests per second per account.'; max five filterGroups with up to 6 filters each, 18 total; default 10 per page, max 200; 'It may take a few moments for newly created or updated CRM objects to appear in search results.'; dates as ISO 8601 or UNIX ms (UTC)."
  - https://developers.hubspot.com/changelog/crm-search-api-rate-limit-increase — official page via search summary — direct fetch blocked in sandbox — "burst limit raised from 4 to 5 requests per second; max objects per response raised from 100 to 200."
  - https://github.com/HubSpot/hubspot-api-nodejs/blob/master/README.md — official SDK source — ""Only 3 `FilterGroups` with max 3 `Filters` are supported." / "Despite `sorts` is an array, however, currently, only one sort parameter is supported." / "`{ propertyName: 'hs_object_id', direction: 'ASCENDING' }`" / filter example { propertyName: "createdate", operator: "GTE", value: "1615709177000" }"
  - https://github.com/HubSpot/hubspot-api-nodejs/blob/master/src/services/decorators/RetryDecorator.ts — official SDK source — "public readonly tenSecondlyRolling = 'TEN_SECONDLY_ROLLING'; public readonly secondlyLimitMessage = 'You have reached your secondly limit.'; retryTimeout = { INTERNAL_SERVER_ERROR: 200, TOO_MANY_REQUESTS: 10 * 1000, TOO_MANY_SEARCH_REQUESTS: 1000 }"
  - https://github.com/HubSpot/hubspot-api-nodejs/blob/master/codegen/crm/contacts/models/PublicObjectSearchRequest.ts — official SDK source — "'after'?: string; 'sorts'?: Array<string>;"
  - https://github.com/Tracardi/tracardi/blob/master/tracardi/process_engine/action/v1/connectors/hubspot/properties.json — community, non-authoritative — "lastmodifieddate: "The date any property on this contact was modified"; recent_conversion_date: "The date this contact last submitted a form""
  - https://github.com/teostereciu/mcpsynth/blob/main/benchmark/datasets/hubspot/docs/api_crm_search-the-crm_2.md — community, non-authoritative (verbatim scrape, 2026-04-13, of https://developers.hubspot.com/docs/api-reference/latest/crm/search-the-crm, 'Last modified on March 30, 2026') — "'It may take a few moments for newly created or updated CRM objects to appear in search results.' / 'Archived CRM objects won't appear in any search results.' / 'The search endpoints are rate limited to _five_ requests per second per account.' / 'The maximum number of supported objects per page is 200.' / 'The search endpoints are limited to 10,000 total results for any given query. Attempting to page beyond 10,000 will result in a 400 error.' / 'you can include a maximum of five `filterGroups` with up to six `filters` in each group, with a maximum of 18 filters in total.' / 'Only one sorting rule can be applied to any search.' / 'By default, the search endpoints will return pages of 10 records at a time.' / 'You must format the value in the `after` parameter as an integer.'"

### HS-INTAKE-WEBHOOK-CALC-PROPS — There is no form-submission webhook, and the brief's "calculated, so can't subscribe" rationale is not official
- **Brief:** §5.2 Poller: "Repeat submissions by existing contacts don't trigger `contact.creation`, and conversion-date properties are calculated, so they can't be webhook-subscribed."
- **Verdict:** Corrected — medium confidence.
- **Finding:**
  - **Officially documented:**
    1. No form-submission webhook event exists. The contact subscription types are `contact.creation`, `contact.deletion`, `contact.propertyChange`, `contact.merge`, `contact.restore`, `contact.associationChange` and `contact.privacyDeletion`, plus the `object.*` equivalents. The specs also contain the string `contact.create`. `contact.creation` fires for new contacts only.
    2. The webhooks guide says: 'Certain properties are not available for CRM property change subscriptions. These properties are: num_unique_conversion_events, hs_lastmodifieddate.'
  - **Not documented:** whether a `contact.propertyChange` subscription on `recent_conversion_date` or `num_conversion_events` fires. Community answers say calculated properties do not.
  - **Verifier correction:** the official text never mentions "calculated". The exclusion is not simply "calculated" either:
    - `hs_lastmodifieddate` is excluded, although it is not in the calculated set;
    - `recent_conversion_date`, `num_conversion_events` and `first_conversion_date` are `calculated:true`, but they are not named.

    The brief's rationale is therefore NOT officially supported. The poller conclusion is unaffected.
  - **Reword the brief's rationale to:** "Repeat submissions by existing contacts don't trigger contact.creation, HubSpot has no form-submission webhook, and property-change webhooks for conversion properties are not documented (num_unique_conversion_events is explicitly excluded)."
- **Design consequence:** Keep the 5-minute poller (the forms submissions API, per selected form) as the guaranteed path.
  - Treat `contact.creation` as a latency hint that enqueues an immediate, debounced poll of that portal's selected forms, rather than trying to identify the form from contact properties.
  - Optionally, treat a `propertyChange` on `recent_conversion_date` the same way, but only if a WIRE_UP test in a developer account shows that it fires.
  - Never treat either as the source of truth.
- **Open risk:**
  - The webhooks guide could not be fetched directly. The exclusion list rests on a search summary plus a community-hosted text copy of the official guide.
  - At WIRE_UP, in a developer test account:
    1. Subscribe to `contact.propertyChange` for `recent_conversion_date` and `num_conversion_events`.
    2. Submit a form twice with the same email.
    3. Record whether the events fire.
- **Sources:**
  - https://developers.hubspot.com/docs/api-reference/latest/webhooks/guide — official page via search summary — direct fetch blocked in sandbox — "'Certain properties are not available for CRM property change subscriptions, including num_unique_conversion_events and hs_lastmodifieddate'"
  - https://github.com/Namit2111/Agent-Jivus/blob/f148315f30fa0db680d75fed9ed9fd22db5a152d/RagAPI/root/docs/api/webhooks/content.txt — community, non-authoritative (text copy of the official guide https://developers.hubspot.com/docs/api-reference/latest/webhooks/guide, lines 338-340) — "'Certain properties are not available for CRM property change subscriptions. These properties are:' / 'num_unique_conversion_events' / 'hs_lastmodifieddate'. The word 'calculated' does not appear in the file."
  - https://github.com/HubSpot/HubSpot-public-api-spec-collection/tree/main/PublicApiSpecs/Webhooks — official OpenAPI spec — "event types in Webhooks / Webhooks Journal specs: "contact.associationChange", "contact.create", "contact.creation", "contact.deletion", "contact.merge", "contact.privacyDeletion", "contact.propertyChange", "contact.restore" and object.* equivalents; no form-submission event"
  - https://github.com/HubSpot/HubSpot-public-api-spec-collection/blob/main/PublicApiSpecs/Webhooks/Webhooks/Rollouts/147891/v3/webhooks.json — official OpenAPI spec — "Event-type strings present: "contact.associationChange", "contact.create", "contact.creation", "contact.deletion", "contact.merge", "contact.privacyDeletion", "contact.propertyChange", "contact.restore" (plus company/deal/ticket/line_item/product/conversation/object.*); no form-related event."

### HS-INTAKE-DEFAULT-LEAD-PROPS — `firstname`, `lastname`, `email`, `company` and `message` are default contact properties
- **Brief:** §5.2: "Fall back to mapped contact properties." §5.4 inputs are the lead's first name, company, message and form name.
- **Verdict:** Confirmed — high confidence.
- **Finding:** These default contact properties are confirmed (internal names):

  | Internal name | Label | Type | Notes |
  |---|---|---|---|
  | `firstname` | First Name | string | |
  | `lastname` | Last Name | string | |
  | `email` | Email | string | The contact's unique key. |
  | `company` | Company Name | string | Separate from the associated company's Name. The dump description is 'Name of the contact's company. This can be set independently from the name property on the contact's associated company.' |
  | `message` | Message | string | `fieldType` `textarea`. Description: 'A default property to be used for any message or comments a contact may want to leave on a form.' `calculated` false, `readOnlyValue` false. |

  - **`message` is overwritten by each new submission.** `propertiesWithHistory` keeps the history. This rests on a KB summary; it is plausible because `message` is a normal writable property.
  - **Field names in submissions:** in a submission's `values[]`, fields mapped to these properties appear with the same name, e.g. `{"name":"message","objectTypeId":"0-1"}`.
  - **Properties returned by default:**
    - `GET` and list return only `firstname`, `lastname` and `email` (spec table ``| `contacts` | `firstname`, `lastname`, `email` |``).
    - Search returns `createdate`, `email`, `firstname`, `hs_object_id`, `lastmodifieddate` and `lastname`.

    Once `properties` is passed, only those properties are returned, so always pass an explicit list.
- **Design consequence:**
  - Extraction order: take the submission's `values[]` first, then fall back to contact properties. Within `values[]`:
    - the message is the field named `message`, or else the form definition's first `multi_line_text` field;
    - the name comes from `firstname` and `lastname`;
    - the company comes from `company`.
  - Because `message` is overwritten, prefer submission values for repeat submissions.
- **Open risk:**
  - Owners may map the message to a custom property. Use the form definition's `multi_line_text` field name to find it.
  - "Overwritten on each submission" rests on a KB search summary. At WIRE_UP, confirm it with two submissions from one contact.
- **Sources:**
  - https://github.com/HubSpot/HubSpot-public-api-spec-collection/blob/main/PublicApiSpecs/Conversations/Custom%20Channels/Rollouts/160898/v3/customChannels.json — official OpenAPI spec — "default contact property enum includes "company", "email", "firstname", "lastname", "message""
  - https://github.com/HubSpot/HubSpot-public-api-spec-collection/blob/main/PublicApiSpecs/CRM/Contacts/Rollouts/424/v3/contacts.json — official OpenAPI spec — "info table: "| `contacts` | `firstname`, `lastname`, `email` |" (properties returned by default)"
  - https://github.com/Tracardi/tracardi/blob/master/tracardi/process_engine/action/v1/connectors/hubspot/properties.json — community, non-authoritative — "{"name": "message", "label": "Message", "description": "A default property to be used for any message or comments a contact may want to leave on a form.", "type": "string", "fieldType": "textarea", "calculated": false, "modificationMetadata": {... "readOnlyValue": false}}"
  - https://knowledge.hubspot.com/properties/hubspots-default-contact-properties — official page via search summary — direct fetch blocked in sandbox — "default property `message` stores free text from a contact form; it is overwritten when the contact submits another form, while property history retains prior values."
  - https://github.com/teostereciu/mcpsynth/blob/main/benchmark/datasets/hubspot/docs/api_crm_search-the-crm_2.md — community, non-authoritative (verbatim scrape of the official search guide) — "'Each object that you search will include a set of default properties that gets returned. For contacts, a search will return `createdate`, `email`, `firstname`, `hs_object_id`, `lastmodifieddate`, and `lastname`.'"

### HS-TIER-AVAILABILITY — The Forms, Contacts, Search, Properties and Emails APIs are available on Free tiers
- **Brief:** §1 targets HubSpot Free and Starter users. §5.1 lists the scopes `oauth`, `crm.objects.contacts.read` and `forms`.
- **Verdict:** Confirmed — medium confidence.
- **Finding:** Yes, per the official specs.
  - **Spec tier metadata:** these specs all carry `x-hubspot-product-tier-requirements` = `FREE` for `marketing`, `sales`, `service`, `cms`, `commerce`, `crmHub` and `dataHub`:
    - Forms v3 (and 2026-09-beta / 2027-03-beta);
    - Contacts v3, including `/search`;
    - Properties v3;
    - Emails v3.

    Verifier: the same holds for Contacts 424/{v3, 2025-09, 2026-03, 2026-09} and 321895/{2026-09, 2026-09-beta}, for Properties 145899/v3, and for every Emails rollout. Contacts 107729/v3 lists only marketing, sales, service and cms, all `FREE`.
  - **Legacy submissions endpoint:** `/form-integrations/v1` has no spec entry and therefore no tier metadata. No tier gating is documented; forms are a free tool.
  - **Rate limits for OAuth public apps:**
    - 110 requests per 10 s per installed account, with no daily limit. This comes from a search summary of the usage guidelines only.
    - Search has a separate limit of 5 requests/s per account. This is corroborated by the verbatim official search guide and by the spec's `x-hubspot-rate-limit-exemptions` `['ten-secondly']` on search.
- **Design consequence:** Intake needs no tier detection. The per-portal request budget for one poll is 1 search + N form calls + M contact reads.
- **Open risk:**
  - The legacy submissions endpoint's tier behaviour is not in any spec. Confirm it on a Free portal during the WIRE_UP smoke test.
  - The 110/10 s figure rests on a search summary. Re-check the usage-guidelines page live.
- **Sources:**
  - https://github.com/HubSpot/HubSpot-public-api-spec-collection/blob/main/PublicApiSpecs/Marketing/Forms/Rollouts/144909/v3/forms.json — official OpenAPI spec — "info.x-hubspot-product-tier-requirements: {"marketing": "FREE", "sales": "FREE", "service": "FREE", "cms": "FREE", "commerce": "FREE", "crmHub": "FREE", "dataHub": "FREE"} (identical in 2026-09-beta and 2027-03-beta)"
  - https://github.com/HubSpot/HubSpot-public-api-spec-collection/blob/main/PublicApiSpecs/CRM/Contacts/Rollouts/424/v3/contacts.json — official OpenAPI spec — "info.x-hubspot-product-tier-requirements: {"marketing": "FREE", "sales": "FREE", "service": "FREE", "cms": "FREE", "commerce": "FREE", "crmHub": "FREE", "dataHub": "FREE"}"
  - https://developers.hubspot.com/docs/developer-tooling/platform/usage-guidelines — official page via search summary — direct fetch blocked in sandbox — "OAuth public apps - each installing HubSpot account 'is limited to 110 requests every 10 seconds'; 'This excludes the CRM Search API'; OAuth calls not subject to daily limits; 429 TEN_SECONDLY_ROLLING."
  - https://developers.hubspot.com/docs/api-reference/search/guide — official page via search summary — direct fetch blocked in sandbox — "'The search endpoints are rate limited to five requests per second per account.'"
  - https://github.com/teostereciu/mcpsynth/blob/main/benchmark/datasets/hubspot/docs/api_crm_search-the-crm_2.md — community, non-authoritative (verbatim scrape of the official search guide) — "'The search endpoints are rate limited to _five_ requests per second per account.'"

### HS-BASELINE-FIRST-OUTREACH — No contact property gives "submission to first logged outbound email"; the baseline needs email-engagement search
- **Brief:** §5.8: "median time from submission to first logged outbound email; leads with no logged outbound email", and "If logged history is insufficient, show 'Not enough logged history'. Never estimate."
- **Resolves:** [VERIFY] §5.1 minimum scopes, in part: an exact §5.8 baseline needs an email-engagement read scope.
- **Verdict:** Corrected — medium confidence.
- **Finding:** No contact property measures 'submission -> first logged outbound EMAIL'. The exact data needs email engagements.

  **Steps:**
  1. Take each selected-form submission in the last 30 days, from `GET /form-integrations/v1/submissions/forms/{formGuid}`.
  2. Resolve each one to a `contactId` by email.
  3. Run `POST /crm/v3/objects/emails/search` (or `/crm/objects/<date>/emails/search`) with this body:
  ```json
  {"filterGroups":[{"filters":[{"propertyName":"associations.contact","operator":"EQ","value":"<contactId>"},{"propertyName":"hs_email_direction","operator":"EQ","value":"EMAIL"},{"propertyName":"hs_timestamp","operator":"GTE","value":"<submittedAt ms>"}]}],"sorts":[{"propertyName":"hs_timestamp","direction":"ASCENDING"}],"properties":["hs_timestamp","hs_email_direction"],"limit":1}
  ```
  The association filter uses the official pseudo-property `associations.{objectType}`.

  **`hs_email_direction` values** (official emails guide):
  - `EMAIL`: sent from the CRM, or logged with the BCC address;
  - `INCOMING_EMAIL`: a reply to a logged outgoing email;
  - `FORWARDED_EMAIL`: forwarded to the CRM.

  **Reading the result:**
  - Time to first outbound = `results[0].hs_timestamp - submittedAt`.
  - `total == 0` means 'no logged outbound email'.
  - Throttle to at most 4 searches/s per portal; the search limit is 5/s per account.

  **Scopes: the official specs conflict.**

  | Spec rollout | Scope requirement |
  |---|---|
  | 424/2026-09 | `crm.objects.contacts.read` AND `sales-email-read` |
  | 321895/2026-09 (`/crm/objects/2026-09/emails/search`) | any one of 79 single-scope alternatives, including `crm.objects.contacts.read` or `crm.objects.emails.read`; no `sales-email-read` |
  | v3 | none declared |

  Plan for `sales-email-read` and confirm it in WIRE_UP.

  **Fallbacks with `crm.objects.contacts.read` only:** these must be labelled as such and never presented as "email".
  - `hs_first_outreach_date`. This is the first outreach on ANY channel by a sales rep, ever, so it is valid only when the submission created the contact (i.e. `first_conversion_date` ≈ `submittedAt`). Dump description: 'The date of the first outreach (call, email, meeting or other communication) from a sales rep to the contact.' It is calculated, hidden and read-only.
  - `hs_sa_first_engagement_date` together with `hs_sa_first_engagement_object_type`. These give the current owner's first engagement and its object type. Per a KB summary, they are cleared or reset when the owner changes. `hs_sa_first_engagement_object_type` ('The object type of the current contact owner's first engagement with the contact.') and `hs_sa_first_engagement_descr` can tell whether that engagement was an email. `hs_sa_first_engagement_date` is `calculated:false` and `readOnlyValue:true` in the dump.

  **Not usable:**
  - `hs_last_sales_activity_timestamp`: it records inbound engagement.
  - `notes_last_contacted`: it is the last contact, on any channel.
  - `hs_time_to_first_engagement`: it is relative to the owner, and its start point and unit are not officially verified.

  If neither path yields data, show 'Not enough logged history'.
- **Design consequence:**
  - The baseline is, for each selected-form submission in the last 30 days (from the submissions API), the first outbound logged email after `submittedAt`.
  - If the scopes stay `oauth` + `crm.objects.contacts.read` + `forms`, fall back to `hs_first_outreach_date`, labelled 'first logged outreach (any channel)'. Use it only for contacts created by that submission (`first_conversion_date == submittedAt`). Otherwise show 'Not enough logged history'.
  - Coordinate the `sales-email-read` decision with the inbox-logging and reply-detection research. It is a read scope, so it is compatible with the read-only law. §02 HS-SCOPES adds it to the required set.
- **Open risk:**
  - The emails-search scope requirements are inconsistent across spec rollouts: 424/v3 has security `[]`, the 321895 rollouts list scopes as alternatives, and 424/2026-09 requires both.
  - The visibility and tier of `hs_first_outreach_date` are not officially confirmed (it is `hidden:true` in a 2023 dump).
  - `hs_time_to_first_engagement`'s start point and the "ms" unit come from a KB summary only.
  - At WIRE_UP, run the emails search above with the final scope set on a portal that has BCC-logged emails, and confirm a 200 with unredacted `hs_timestamp` / `hs_email_direction`.
- **Sources:**
  - https://github.com/HubSpot/HubSpot-public-api-spec-collection/blob/main/PublicApiSpecs/Conversations/Custom%20Channels/Rollouts/160898/v3/customChannels.json — official OpenAPI spec — "enum includes "hs_first_outreach_date", "hs_sa_first_engagement_date", "hs_time_to_first_engagement", "notes_last_contacted", "num_contacted_notes", "hs_last_sales_activity_timestamp", "hs_sales_email_last_replied""
  - https://github.com/HubSpot/HubSpot-public-api-spec-collection/blob/main/PublicApiSpecs/CRM/Emails/Rollouts/424/2026-09/emails.json — official OpenAPI spec — "POST /crm/objects/2026-09/{objectType}/search security [{"oauth2": ["crm.objects.contacts.read", "sales-email-read"]}, {"private_apps": ["crm.objects.contacts.read", "sales-email-read"]}] (both scopes in one requirement = AND); /crm/v3/objects/emails/search in 424/v3 has security []"
  - https://github.com/HubSpot/HubSpot-public-api-spec-collection/blob/main/PublicApiSpecs/CRM/Emails/Rollouts/321895/2026-09/emails.json — official OpenAPI spec — "POST /crm/objects/2026-09/emails/search security: 79 single-scope alternatives (each requirement has exactly 1 scope), including {"oauth2": ["crm.objects.contacts.read"]} and {"oauth2": ["crm.objects.emails.read"]}; no sales-email-read. This conflicts with 424/2026-09 [{"oauth2": ["crm.objects.contacts.read", "sales-email-read"]}]."
  - https://developers.hubspot.com/docs/api-reference/crm-emails-v3/guide — official page via search summary — direct fetch blocked in sandbox — "hs_email_direction values EMAIL (sent from the CRM or sent and recorded with the BCC address), INCOMING_EMAIL (reply to a recorded outgoing email), FORWARDED_EMAIL; related changelog 'Announcement: New scope required to get the content of email engagements'."
  - https://github.com/teostereciu/mcpsynth/blob/main/benchmark/datasets/hubspot/docs/api_emails_guide_2.md — community, non-authoritative (verbatim scrape of the official emails guide, https://developers.hubspot.com/docs/api-reference/latest/crm/activities/emails/guide) — "'`hs_email_direction`| The direction the email was sent in. Possible values include:`EMAIL`: the email was sent from the CRM or sent and logged to the CRM with the BCC address.`INCOMING_EMAIL`: the email was a reply to a logged outgoing email. `FORWARDED_EMAIL`: the email was forwarded to the CRM.'"
  - https://github.com/teostereciu/mcpsynth/blob/main/benchmark/datasets/hubspot/docs/api_crm_search-the-crm_2.md — community, non-authoritative (verbatim scrape of the official search guide, 'Search through associations') — "'Search for records that are associated with other specific records by using the pseudo-property `associations.{objectType}`.' Example body: "filters": [{"propertyName": "associations.contact", "operator": "EQ", "value": "123"}]."
  - https://knowledge.hubspot.com/properties/hubspots-default-contact-properties — official page via search summary — direct fetch blocked in sandbox — "Last contacted = last date a chat conversation, call, non-forwarded one-to-one email, meeting, or manually entered LinkedIn/SMS/WhatsApp message was logged; Date of first engagement cleared if Contact owner is set to No owner; First outreach date = first outreach (call, email, meeting or other communication) from a sales rep."
  - https://knowledge.hubspot.com/properties/hubspots-default-lead-properties — official page via search summary — direct fetch blocked in sandbox — "First outreach date automatically set and can't be modified; Lead response time = time the current owner took to do first qualifying engagement (ms); Last engagement date covers one-to-one email opens/clicks, revisits, meeting bookings and form submissions."
  - https://github.com/Tracardi/tracardi/blob/master/tracardi/process_engine/action/v1/connectors/hubspot/properties.json — community, non-authoritative — "hs_first_outreach_date: "The date of the first outreach (call, email, meeting or other communication) from a sales rep to the contact." calculated true hidden true readOnlyValue true; ... hs_last_sales_activity_timestamp "Last Engagement Date" "The last time a contact engaged with your site or a form, document, meetings link, or tracked email. ..." ; notes_last_contacted "The last time a call, chat conversation, LinkedIn message, postal mail, meeting, sales email, SMS, or WhatsApp message was logged for a contact."" and "hs_sa_first_engagement_object_type: label 'Type of first engagement', 'The object type of the current contact owner's first engagement with the contact.', enumeration, calculated true; hs_sa_first_engagement_descr: 'A description of the current contact owner's first engagement with the contact.'; hs_sa_first_engagement_date calculated false, readOnlyValue true"

### HS-API-VERSIONING-PATHS — Dated CRM paths exist for contacts and emails; forms have only v3 and betas, and form submissions only legacy v1
- **Brief:** not addressed (the endpoints used by `HubSpotClient` in §5.1 and §5.2).
- **Verdict:** Extended — medium confidence. The brief is silent here. The research verdict was "corrected" because the verifier changed the original finding's default path.
- **Finding:**
  - **Versioning rules:** under HubSpot's date-based versioning (introduced with 2026-03), dated paths replace numeric ones, and HubSpot tells new integrations to use the latest date version. Older versions keep working 'until its end-of-life date'; no v3 end-of-life date was found in this cluster.
  - **Availability in the official spec collection at 2026-10-01:**

    | API | Paths in the spec collection |
    |---|---|
    | Contacts read/search | `/crm/v3/objects/contacts[/search]` (legacy); `/crm/objects/2025-09\|2026-03/contacts[/search]`; and 2026-09, as `/crm/objects/2026-09/contacts/search` in rollout 321895 and the generic `/crm/objects/2026-09/{objectType}/search` in rollout 424 |
    | Emails | `/crm/v3/objects/emails/search` and `/crm/objects/2025-09\|2026-03\|2026-09/emails/search` |
    | Forms | only `/marketing/v3/forms[/{formId}]` as GA, plus `/marketing/forms/2026-09-beta` and `/2027-03-beta` (do not use the betas) |
    | Form submissions | only the legacy `/form-integrations/v1/submissions/forms/{formGuid}` |
  - **Recommendation:** in `HubSpotClient` config, use these defaults:
    - `CRM_OBJECTS_BASE` = `'/crm/objects/2026-03'`, the GA version documented in the current docs. Switch to 2026-09 after a WIRE_UP check.
    - `FORMS_BASE` = `'/marketing/v3/forms'`.
    - `SUBMISSIONS_BASE` = `'/form-integrations/v1/submissions/forms'`.

    Keep v3 as a one-line fallback. Per the spec, the request and response shapes are identical between v3 and 2026-03 for the operations used (`PublicObjectSearchRequest`, `SimplePublicObject`).
  - **Current docs:** the v3 CRM search guide now lives under `/docs/api-reference/legacy/`, while `/latest/` shows `/crm/objects/2026-03/{object}/search`.
- **Design consequence:** Centralise the base paths in `HubSpotClient` config, so moving between v3, 2026-03 and 2026-09 is a one-line change. Never use `*-beta` paths in production.
- **Open risk:**
  - This cluster did not verify the v3 sunset timeline. §02 HS-API-VERSIONING records that v1–v3 APIs become unsupported with September 2027 enforcement, and recommends the latest GA version, `2026-09`. Reconcile the default (`2026-03` here, `2026-09` there) in PLAN.
  - At WIRE_UP, confirm that the chosen dated contacts and emails search paths answer with the final scopes.
- **Sources:**
  - https://github.com/HubSpot/HubSpot-public-api-spec-collection/blob/main/PublicApiSpecs/CRM/Contacts/Rollouts/424/v3/contacts.json — official OpenAPI spec — "paths include /crm/v3/objects/contacts/search; sibling rollouts 424/2026-03 contain '/crm/objects/2026-03/contacts/search'"
  - https://github.com/HubSpot/HubSpot-public-api-spec-collection/blob/main/PublicApiSpecs/Marketing/Forms/Rollouts/144909/2026-09-beta/forms.json — official OpenAPI spec — "Forms spec family paths: /marketing/v3/forms[/{formId}], /marketing/forms/2026-09-beta[/{formId}], /marketing/forms/2027-03-beta[/{formId}]"
  - https://github.com/teostereciu/mcpsynth/blob/main/benchmark/datasets/hubspot/docs/api_latest_overview.md — community, non-authoritative (verbatim scrape of the official https://developers.hubspot.com/docs/api-reference/latest/overview, 'Last modified on March 31, 2026') — "'The 2026-03 APIs use a date-based versioning scheme that replaces the previous numeric version paths (e.g., `/crm/v3/`).' / 'When a new date version is released, the previous version continues to work until its end-of-life date, giving you time to migrate. For new integrations, always use the latest date version.'"
  - https://github.com/teostereciu/mcpsynth/blob/main/benchmark/datasets/hubspot/docs/api_crm_search-the-crm.md — community, non-authoritative (scrape of https://developers.hubspot.com/docs/api-reference/legacy/crm/search-the-crm) — "v3 paths, e.g. '/crm/v3/objects/contacts/search' vs. the /latest/ page using '/crm/objects/2026-03/contacts/search'. Otherwise the texts are identical (diff shows only title and link changes)."

### 04.x Verifier-added items

#### HS-INTAKE-V1-CONTACT-PROFILE-FORM-SUBMISSIONS — The legacy Contacts v1 profile `form-submissions` array: do not build on it
- **Brief:** not addressed. The question is whether there is an official per-contact way to see WHICH form (GUID) a contact submitted, e.g. for the `contact.creation` webhook path.
- **Resolves:** [VERIFY] §5.2 which properties or Forms API data identify the submitting form. This finding evaluates an alternative path and rejects it.
- **Verdict:** Not officially documented — low confidence. The parameter is documented (seen through a verbatim scrape of the official legacy page); the shape of the array elements is not.
- **Finding:**
  - The only official per-contact route is the legacy Contacts v1 profile endpoints.
  - They document `formSubmissionMode` ('One of all, none, newest, oldest to specify which form submissions should be fetched. Default is newest.') and return a top-level `"form-submissions"` array alongside `"properties"`.
  - No reachable official text shows the element shape (form id, timestamp, page URL); the doc example has `"form-submissions": []`.
  - Only the utk variant (`/contacts/v1/contact/utk/{utk}/profile`) was verified.
  - Contacts v1 is under the 'legacy' docs.
- **Design consequence:** Do not build on it. Use the forms submissions API, keyed by the selected form GUIDs, as the source of truth, and treat `contact.creation` as a trigger for an immediate poll.
- **Open risk:** If this endpoint is ever needed, verify the element shape in WIRE_UP first. §02 HS-API-VERSIONING records the v1–v3 support deadlines.
- **Sources:**
  - https://github.com/teostereciu/mcpsynth/blob/main/benchmark/datasets/hubspot/docs/api_v1_get-contacts-v1-contactutkcontactutk-profile.md — community, non-authoritative (verbatim scrape of the official https://developers.hubspot.com/docs/api-reference/legacy/crm/objects/contacts/v1/get-contacts-v1-contactutkcontactutk-profile) — "'formSubmissionMode string One of `all`, `none`, `newest`, `oldest` to specify which form submissions should be fetched. Default is `newest`.'; example response contains "form-submissions": []."

#### HS-INTAKE-V2-SEARCH-REQUEST-FORMAT — Request formatting rules for the contacts-search poller
- **Brief:** §5.2 Poller (the details behind "[VERIFY search support]").
- **Resolves:** [VERIFY] §5.2 search support (request details).
- **Verdict:** Extended — high confidence. The source is a verbatim scrape of the official search guide, corroborated by the official spec and the official Node SDK README. The scrape itself is hosted by a third party.
- **Finding:** The official search guide gives these rules:
  - **Datetime filter values:** send them as epoch-ms strings. The guide's only datetime example is `"value":"1579514400000"`; it does not state that ISO is accepted.
  - **`after`:** must be the integer-formatted string from `paging.next.after` ('You must format the value in the after parameter as an integer'). Start with `"0"` or omit it.
  - **Archived contacts** never appear.
  - **Default properties:** contacts search returns `createdate`, `email`, `firstname`, `hs_object_id`, `lastmodifieddate` and `lastname` unless `properties` is given.
  - **Size cap:** the request body/query is capped at 3,000 characters; anything longer returns 400.
  - **Limits:**
    - 5 requests/s per account;
    - 10,000 results per query;
    - 5 `filterGroups` × 6 filters, 18 in total;
    - one sort.
  - **`sorts` typing:** the official spec types `sorts` as `Array<string>`, while the docs use `[{"propertyName","direction"}]` objects.
  - **Body for the poller:**
  ```json
  {"filterGroups":[{"filters":[{"propertyName":"recent_conversion_date","operator":"GTE","value":"<cursorMs - overlapMs>"}]}],"sorts":[{"propertyName":"recent_conversion_date","direction":"ASCENDING"}],"properties":["email","recent_conversion_date","num_conversion_events"],"limit":200}
  ```
- **Design consequence:**
  - Build search bodies with a single typed builder that always passes `properties`, sends epoch-ms strings and copies `paging.next.after` verbatim.
  - Assert in a unit test that the serialised body stays under 3,000 characters.
- **Open risk:** The guide was read only as a third-party scrape. At WIRE_UP, re-check live that an epoch-ms `GTE` filter on `recent_conversion_date` and an object-form `sorts` entry are accepted.
- **Sources:**
  - https://github.com/teostereciu/mcpsynth/blob/main/benchmark/datasets/hubspot/docs/api_crm_search-the-crm_2.md — community, non-authoritative (verbatim scrape of the official https://developers.hubspot.com/docs/api-reference/latest/crm/search-the-crm) — "'You must format the value in the `after` parameter as an integer.' / 'Archived CRM objects won't appear in any search results.' / 'A query can contain a maximum of 3,000 characters. If the body of your request exceeds 3,000 characters, a 400 error will be returned.' / 'For contacts, a search will return `createdate`, `email`, `firstname`, `hs_object_id`, `lastmodifieddate`, and `lastname`.' / BETWEEN example uses "value":"1579514400000"."
  - https://github.com/HubSpot/hubspot-api-nodejs/blob/master/README.md — official SDK source — "'Despite `sorts` is an array, however, currently, only one sort parameter is supported.' / TS: 'use `["-createdate"]` to sort in desc and sorts: `["createdate"]` in asc order.' / '`after` for initial search should be set as 0'"

### 04.y Test vectors

This cluster has **no test vectors**. Nothing was published by HubSpot as a vector, and nothing was generated locally with an official SDK. The request and response bodies above are illustrations built from spec schemas and docs examples, not official vectors. The research and verification records say so verbatim (only the local scratch-file paths in the verifier text are omitted):

```text
Research: None (no cryptographic or known test vectors in this cluster). The example request and response bodies in the findings are illustrations, not official vectors.
```

```text
Verifier recheck: The cluster has no cryptographic test vectors, and the original finding claimed none. Re-executed local checks: (1) Python membership test of the 20 cited names in customChannels v3 PreResolvedContact.contactPropertiesLeadingToMatch.items.enum (410 items): all True; hs_lastmodifieddate is NOT in the enum. (2) Tracardi dump re-read: every quoted label/description/calculated/readOnlyValue value reproduced exactly. (3) Full-history scan of HubSpot-public-api-spec-collection (660,021 commits): no forms-submissions spec ever added. (4) hubspot/hubspot-php Forms.php re-fetched (HTTP 200) and the path reproduced. (5) Node SDK README/RetryDecorator/FormsApi/PublicObjectSearchRequest lines reproduced. Not re-checkable: WebSearch-summary claims (search budget exhausted; developers.hubspot.com and knowledge.hubspot.com blocked). Where possible these were replaced by a verbatim third-party scrape of the official developer docs (teostereciu/mcpsynth, scraped 2026-04-13).
```

**Fixtures for the fake `HubSpotClient` and the simulation (derived, not vendor vectors):**
- newest-first submissions in 50-item pages, with `conversionId` sometimes absent;
- a repeat submission by an existing contact, which appears in the submissions API but not as `contact.creation`;
- a newsletter form with only an `email` field and lifecycle stage `subscriber`;
- datetime property values in both ISO-8601 and epoch-ms string form.
