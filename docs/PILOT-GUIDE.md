# Pilot guide: a real identity provider and a real serial device

Two things in WirePulse have never been checked against the real world: sign-in and provisioning with a customer's own **Okta or Microsoft Entra ID**, and the gateway agent with a **real USB/UART device**. The automated tests use a local OpenID provider, token shapes imitating Okta and Entra, protocol testers for SCIM, and a pseudo-terminal for the serial port. This guide is the procedure for doing both checks once, with one customer, in about two weeks, and for writing down what happened so that the documentation can say it truthfully afterwards.

It is written for the person running the pilot (an engineer on your side), working with the customer's IT administrator and one lab engineer.

## 0. Before you start

- **A written pilot agreement.** The [LICENSE](../LICENSE) grants no right to run WirePulse without one. It should say what the pilot is for, how long it runs, who may use it, what happens to the data afterwards, and that this is pre-release software with the limits listed in [SECURITY.md](../SECURITY.md) and [DEPLOYMENT.md](../DEPLOYMENT.md#readiness-and-known-limits). Have a lawyer write it; this guide is not legal advice.
- **A test tenant or test users**, not the company's production sign-in and not a production line. Ask for a dedicated application registration, three test users (an administrator, an engineer, a leaver you will deactivate) and, for the hardware part, one bench device that nothing depends on.
- **A running deployment** that follows [DEPLOYMENT.md](../DEPLOYMENT.md) with a real certificate, and a clean `scripts/acceptance.mjs` run against it. Keep one administrator account that the customer's identity provider does not manage, so a mistake in provisioning cannot lock everyone out.
- **Success criteria agreed in writing** with the customer: section 5 below is a starting point.

## 1. Identity provider: what to ask the customer's administrator for

| You need | Okta | Microsoft Entra ID |
|---|---|---|
| `OIDC_ISSUER` | The issuer of a **custom authorization server**, `https://<org>.okta.com/oauth2/<server id>` (the built-in one is `…/oauth2/default`). The org authorization server's tokens are meant for Okta's own APIs and will not work | `https://login.microsoftonline.com/<tenant id>/v2.0` |
| `OIDC_AUDIENCE` | The authorization server's **Audience** value (`api://default` for the default server) | The **client ID (a GUID) of the app registration that represents the API**. For v2.0 tokens `aud` is that GUID, not the `api://…` URI |
| Token version | n/a | The API's app registration must issue **v2.0** access tokens (`requestedAccessTokenVersion` is 2 in its manifest; older manifests call it `accessTokenAcceptedVersion`). v1.0 tokens carry a different issuer, `https://sts.windows.net/<tenant>/` |
| Email on the access token | Add an `email` claim and an `email_verified` claim to the authorization server's access-token claims | Add `email` as an optional claim of the API's app registration. Check whether your tenant also issues `email_verified`; if it does not, read the paragraph under the table |
| Test users | Assigned to the application, with an email address | Assigned to the application, with a mail attribute |

Menu names change between releases; use the vendor's current documentation for the clicks. The table says what to ask for, not where to find it.

**The email claim matters.** WirePulse identifies a person by the token's `sub`, but accepts an invitation, and binds a person created by SCIM, by **email**, and it only believes an email when the token says `email_verified: true` (the JSON boolean). A token without it signs in but gets `403 insufficient_workspace_role` at the invitation or the first SCIM-bound request. If the provider cannot issue `email_verified`, `OIDC_TRUST_UNVERIFIED_EMAIL=true` makes the `email` claim count; that is acceptable only when the issuer is one organisation that controls its users' addresses.

**Google (Workspace or Google accounts).** Google is not a direct choice for `OIDC_ISSUER`, and it has not been validated with WirePulse. WirePulse expects the provider to issue an **access token for your API's audience**. Google issues access tokens for Google's own APIs, and an ID token only to the sign-in client; do not pass either one to WirePulse as though it were an API access token. Use a broker that signs people in with Google and issues its own tokens for WirePulse, such as Keycloak, Dex, Okta, or Auth0 with Google as the upstream login. Limit upstream login to your own Workspace domain (otherwise any Google account can reach the broker), and let the broker mark `email_verified` true only for addresses it obtained from that domain. Validate the entire sign-in and provisioning flow with the chosen broker and tenant.

## 2. Identity provider: get a real token and check it

1. Configure the API with `OIDC_ISSUER` and `OIDC_AUDIENCE` and restart it.
2. Obtain an **access token** for the API as a test user. This step is about the token the API sees. (Browser sign-in, with **Sign in with SSO**, is checked in step 5 once `OIDC_CLIENT_ID` is set; pasting a token into the **Enterprise workspace** panel also works, see the [user guide](../USER_GUIDE.md#61-connect).) Ways to get one by hand: Postman's OAuth 2.0 authorization (authorization code with PKCE), the provider's device-code flow, or whatever the customer's developers already use. It must be the access token for **your API's audience**, not an ID token and not a Microsoft Graph token.
3. Save it in a file only you can read, and run the checker. It uses the API's own verification code and never prints the token:

   ```sh
   umask 077; pbpaste > /tmp/token.txt          # or paste it into the file
   docker compose run --rm --no-deps -T api node src/check-token.mjs < /tmp/token.txt
   ```

   It prints the header and the claims WirePulse looks at, then `VERDICT: ACCEPTED` with the subject and email it would use, or `REJECTED` with the reason and the likely cause (wrong issuer, wrong audience, v1.0 token, expired, signed by another key, provider unreachable, Graph token, no email). Exit status is 0, 1 or 2. `--json` gives the same as data. Delete the token file afterwards.
4. Repeat for each test user. Record the verdict, the claim **names** present, and whether `email` and `email_verified` were there. If you pass a result to anyone, send claim names and the verdict, not the token and not real addresses.
5. Register the console as a **public client with authorization code and PKCE** in the provider, add the address the console is served from as an allowed redirect, set `OIDC_CLIENT_ID` (see [DEPLOYMENT.md](../DEPLOYMENT.md#browser-sign-in-sso)), and sign in to the console with **Sign in with SSO**. Record anything the provider needs beyond the standard setup (the audience mapper or scope that makes the access token carry your API's audience, `OIDC_SCOPES`, `OIDC_AUTHORIZE_AUDIENCE=true` for Auth0): browser sign-in has only been run against Keycloak, so this step is where a real tenant may differ. Then create a workspace, **invite** the second test user by email, and have them accept it with their own token. This is the step that fails if the email claim is wrong.

## 3. Identity provider: provisioning (SCIM)

Needs a workspace on a plan that allows SCIM tokens (`business` or `enterprise`).

1. Console → **Provisioning** → **Create token**. In the provider, create a SCIM 2.0 application with base URL `https://<api host>/scim/v2`, bearer-token authentication with that token, unique identifier `userName`, and push of create, update and deactivate turned on. Details and the role mapping are in [DEPLOYMENT.md](../DEPLOYMENT.md#provisioning-people-and-directory-groups-scim-20).
2. Assign a test user to the application. The person must appear under **Provisioned people** as *pending*; when they sign in they become *active* and get the role you mapped.
3. Change their role at the provider and confirm the new role arrives.
4. Open a live job view as that user, then **deactivate** them at the provider. Measure the time until the membership disappears and the open view closes. Expect seconds on WirePulse's side; how soon the provider sends the change is the provider's schedule, so record both.
5. Reactivate, then delete. Confirm the last administrator cannot be removed through SCIM.
6. If you use Groups, create or assign one in the provider, add and remove one already-provisioned User, and confirm the provider's reconciliation. Confirm the Group change does not grant workspace access or change a role; record the provider's payload and any differences from the documented contract.
7. Let a token expire or revoke it and confirm the provider shows an error rather than silently continuing.

SCIM has so far been exercised only by protocol testers and by requests shaped like Okta's and Entra's documented ones. If a real provider sends something unexpected, the audit log and the API log show the request; keep both.

## 4. Real serial device

A gateway process drives one device (`WIREPULSE_SERIAL_PATH`); install it as in [DEPLOYMENT.md](../DEPLOYMENT.md#run-a-gateway-agent) on a Linux machine with the device plugged in, user in the `dialout` (or `uucp`) group. The agent is plain Node and `serialport` supports other systems, but only Linux with systemd has been written up, and nothing has run on real hardware yet. The profile's `baud`, `dataBits`, `stopBits`, `parity`, `ending` and `flow` settings reach the port.

Record the adapter and the device for each run: USB-serial chip (FTDI, CP210x, CH340, a native USB CDC port such as ESP32-S3 or RP2040), the device and firmware, the host and kernel, the cable.

| # | Check | Pass means | Record |
|---|---|---|---|
| 1 | Start the gateway | Gateways tab shows it **online** and lists the port | Port name, time to appear |
| 2 | One command, one expected reply | A job with a single test passes; **Details** shows evidence fingerprints and byte counts | Round-trip time |
| 3 | The device's real settings | Passes at the device's baud rate and format (try its slowest and fastest, and 8N1 plus one other format if it supports it); hardware flow control if used | Settings used |
| 4 | Line endings and echo | Works with `ending` `\n` and `\r\n` as the device needs; a device that echoes its input does not make the test pass by reading its own echo | Which ending |
| 5 | Reset on open | Note whether opening the port resets the board (many do, through DTR/RTS) and whether the boot messages arrive before the test's first command; adjust timeouts or retries in the test | Yes/no, boot time |
| 6 | Boot noise and long output | A test still passes with the device printing logs between replies; 60 s of continuous output at the device's maximum rate leaves the byte counts in the evidence matching what the device says it sent | Bytes sent vs. recorded |
| 7 | Non-ASCII output | Multi-byte UTF-8 from the device shows correctly in the console | |
| 8 | Unplug during idle | The gateway goes offline or recovers; the next job after replugging passes | Time to recover |
| 9 | Unplug during a job | The job is not reported as passed; its lease expires and it is queued again (up to `JOB_MAX_ATTEMPTS`); after replugging it completes | Final status, attempts |
| 10 | Restart | `systemctl restart wirepulse-gateway` and a host reboot both leave the gateway online without help | |
| 11 | Repetition | 100 jobs queued back to back all pass | Failures, with the agent log |
| 12 | Overnight | The gateway is still online in the morning, memory and open file count have not grown | `ps` and `/proc/<pid>/fd` before and after |

Anything that fails here is a finding about the product, not about the device: write down the exact device behaviour, the profile settings and the agent log lines (the token is masked in them).

## 5. Success criteria (a starting point)

- **Identity.** The checker accepts a real access token from each test user; browser sign-in with **Sign in with SSO** works and renews the session (a pasted token also works); an invitation is accepted by email; with SCIM, create, role change and deactivate work, deactivation removes access in seconds on WirePulse's side; if Groups are used, their members are existing provisioned Users and membership does not grant access or change roles; an expired or revoked SCIM token is refused.
- **Device.** Checks 1–4 and 8–11 pass on at least one adapter and device combination; checks 5–7 and 12 are understood even if they need test changes.
- **Operations.** The customer's administrator can follow the guide without help from the developers, and what they got stuck on is written down.

## 6. After the pilot

Write up what was run, by whom, on what, and what each check gave: a table of the checks above with the date, the product and version (Okta org type or Entra tenant type; adapter chip and device), the result and anything surprising. Keep it with the customer's agreement.

Only then change the documentation, and only for what was actually done: the "not tested against Okta, Entra ID…" sentences in [README.md](../README.md), [SECURITY.md](../SECURITY.md), [DEPLOYMENT.md](../DEPLOYMENT.md#readiness-and-known-limits) and [SECURITY-QUESTIONNAIRE.md](SECURITY-QUESTIONNAIRE.md), and the real-hardware line in the same places. "Tested with one customer's Okta org on `<date>`" is a claim you can defend; "works with Okta" is not. Fix every defect found and add a test that reproduces it before closing the pilot.
