# SSO Setup Guide

## Overview

The Kaltura for Adobe Creative Cloud plugin supports Single Sign-On (SSO) via the Kaltura Auth Broker. Users authenticate through their organization's Identity Provider (Okta, Azure AD, SAML, etc.) and receive a session token that they paste back into the plugin.

This guide covers how to configure SSO for a customer account.

## Architecture

```
Plugin (UXP)          Landing Page (GitHub Pages)       Auth Broker         Customer IdP
     │                         │                            │                    │
     │  opens browser ──────▶  │                            │                    │
     │                         │  POST /spa-proxy/login ──▶ │                    │
     │                         │  ◀── HTML auto-submit form │                    │
     │                         │  submits form ───────────▶ │                    │
     │                         │                            │  redirects ──────▶ │
     │                         │                            │                    │ user authenticates
     │                         │                            │  ◀── SAML/OIDC ── │
     │                         │  ◀── redirect ?ks=TOKEN    │                    │
     │                         │  shows token to user       │                    │
     │  ◀── user pastes token  │                            │                    │
     │  validates via user.get │                            │                    │
     │  login complete         │                            │                    │
```

**Key points:**

- The SPA Proxy endpoint (`/spa-proxy/login`) requires **no authentication** — it uses its own internal service KS
- The landing page is static HTML hosted at: `https://kaltura.github.io/kaltura-premiere-panel/sso-callback.html`
- The plugin sends `appType: "test"` — customer configurations must match this value
- Auth Broker redirects to the landing page with `?ks=<TOKEN>` via HTTP-GET

## Prerequisites

1. Customer has an active Kaltura account with a known **Partner ID**
2. Customer has SSO configured in Kaltura KMC (an **auth profile** exists pointing to their IdP)
3. You have an **admin KS** for the customer's partner (or a system admin KS)
4. You know the customer's **email domain** (e.g., `acme.com`)
5. You know which **region** the customer is on:

| Region       | Auth Broker Base URL                       |
| ------------ | ------------------------------------------ |
| US (default) | `https://auth.nvp1.ovp.kaltura.com/api/v1` |
| EU           | `https://auth.eu1.ovp.kaltura.com/api/v1`  |
| DE           | `https://auth.de1.ovp.kaltura.com/api/v1`  |

## Setup Steps

All Auth Broker admin API endpoints use:

- **Method:** POST
- **Header:** `Authorization: ks <ADMIN_KS>`
- **Content-Type:** `application/json`

Replace `<BASE_URL>` with the region-specific URL from the table above.

### Step 1: Find the customer's existing auth profile

```bash
curl -X POST "<BASE_URL>/auth-profile/list" \
  -H "Authorization: ks <ADMIN_KS>" \
  -H "Content-Type: application/json" \
  -d '{"pid": <PARTNER_ID>}'
```

From the response, note the `_id` of the auth profile that connects to their IdP. If none exists, SSO must first be configured through KMC admin settings.

### Step 2: Create an app-registry entry

This links the customer's email domain + `appType` to their auth profile, allowing the SPA Proxy to route login requests to the correct IdP.

```bash
curl -X POST "<BASE_URL>/app-registry/add" \
  -H "Authorization: ks <ADMIN_KS>" \
  -H "Content-Type: application/json" \
  -d '{
    "pid": <PARTNER_ID>,
    "appType": "test",
    "organizationDomain": {
      "domain": "<CUSTOMER_EMAIL_DOMAIN>"
    },
    "authProfileIds": ["<AUTH_PROFILE_ID>"]
  }'
```

**Important:** `appType` must be exactly `"test"` — this is what the plugin sends.

From the response, note the `appGuid` value.

### Step 3: Create an app subscription

This defines where Auth Broker redirects after successful authentication.

```bash
curl -X POST "<BASE_URL>/app-subscription/add" \
  -H "Authorization: ks <ADMIN_KS>" \
  -H "Content-Type: application/json" \
  -d '{
    "appGuid": "<APP_GUID_FROM_STEP_2>",
    "authProfileIds": ["<AUTH_PROFILE_ID>"],
    "appLandingPage": "https://kaltura.github.io/kaltura-premiere-panel/sso-callback.html",
    "appErrorPage": "https://kaltura.github.io/kaltura-premiere-panel/sso-callback.html?error=Authentication+failed",
    "redirectMethod": "HTTP-GET"
  }'
```

### Step 4: Verify the setup

Test the SPA Proxy directly (no auth needed):

```bash
curl -X POST "<BASE_URL>/spa-proxy/login" \
  -H "Content-Type: application/json" \
  -d '{"email": "user@<CUSTOMER_EMAIL_DOMAIN>", "appType": "test"}'
```

**Expected response:** HTML containing a `<form>` with `action=` pointing to the Auth Broker login endpoint and a hidden `token` input. This form auto-submits and redirects the user to their IdP.

**Error responses:**
| Response | Meaning |
|----------|---------|
| `404` or empty | No app-registry entry found for this domain + appType |
| `ORGANIZATION_ID_MISSING` | Multiple app-registry entries match — user must provide Organization ID |
| HTML form | Success — form will redirect to the IdP |

## Multi-PID Customers (Organization ID)

If a customer has **multiple Partner IDs** under the same email domain with the same `appType`, the SPA Proxy returns an `ORGANIZATION_ID_MISSING` error because it cannot determine which app-registry entry to use.

In this case, the user must enter their **Organization ID** in the plugin's SSO form. The Organization ID is the `_id` of the app-registry entry (returned in Step 2).

To find it later:

```bash
curl -X POST "<BASE_URL>/app-registry/list" \
  -H "Authorization: ks <ADMIN_KS>" \
  -H "Content-Type: application/json" \
  -d '{"pid": <PARTNER_ID>}'
```

Share the relevant `_id` with the customer's admin so they can distribute it to their users.

## What the User Does

1. Open the Kaltura plugin in Premiere Pro or Photoshop
2. Switch to the **SSO** tab
3. Enter their **work email** (e.g., `jane@acme.com`)
4. (Optional) Enter **Organization ID** if prompted or if they have multiple accounts
5. Click **Sign In with SSO**
6. Browser opens → they authenticate at their organization's IdP
7. After successful authentication, the callback page displays a token and auto-copies it to clipboard
8. Return to the Adobe application and paste the token in the token field
9. Click **Complete Login** → done

## Tested Reference Configuration

The following configuration was verified end-to-end (Stripe case #REDACTED_CASE):

| Field                | Value                                                                |
| -------------------- | -------------------------------------------------------------------- |
| Region               | nvp1                                                                 |
| Partner ID           | REDACTED_PID                                                               |
| Email domain         | kaltura.com                                                          |
| appType              | test                                                                 |
| Auth profile         | `REDACTED_AUTH_PROFILE_ID` (Okta — `REDACTED_OKTA_APP_NAME`)      |
| App-registry appGuid | `REDACTED_APP_GUID`                                           |
| App subscription ID  | `REDACTED_SUBSCRIPTION_ID`                                           |
| Landing page         | `https://kaltura.github.io/kaltura-premiere-panel/sso-callback.html` |
| Redirect method      | HTTP-GET                                                             |
| IdP                  | Okta (`REDACTED_OKTA_APP_ID`)                                        |

## Troubleshooting

### "Authentication Failed" on the callback page

- Verify the auth profile points to the correct IdP application
- Check that the user is assigned to the IdP application (e.g., in Okta, the user must be assigned to the Kaltura app)
- Verify the `appLandingPage` URL in the subscription is exactly `https://kaltura.github.io/kaltura-premiere-panel/sso-callback.html`

### SPA Proxy returns 404

- The app-registry entry doesn't exist for this domain + appType combination
- Verify `appType` is exactly `"test"` (case-sensitive)
- Verify the `organizationDomain.domain` matches the user's email domain exactly

### "Multiple identity providers configured" error

- Multiple app-registry entries match the same domain + appType
- User needs to provide their Organization ID in the plugin's SSO form
- Find the correct Organization ID via `app-registry/list`

### Token paste fails with "Invalid or expired token"

- The KS token has a limited lifetime (typically 24 hours from issuance)
- If the user waited too long between authenticating and pasting, they need to authenticate again
- Verify the Kaltura server URL in the plugin matches the environment the KS was issued for

### User gets "App Not Assigned" at the IdP

- The user is not assigned to the IdP application
- In Okta: Admin → Applications → find the app → Assignments → Add the user/group
- In Azure AD: Enterprise Applications → find the app → Users and groups → Add

## Modifying or Removing SSO Configuration

### Update subscription (e.g., change landing page)

```bash
curl -X POST "<BASE_URL>/app-subscription/update" \
  -H "Authorization: ks <ADMIN_KS>" \
  -H "Content-Type: application/json" \
  -d '{
    "id": "<SUBSCRIPTION_ID>",
    "appLandingPage": "https://new-landing-page.example.com/sso-callback.html",
    "redirectMethod": "HTTP-GET"
  }'
```

### Remove SSO for a customer

Remove the app subscription and app-registry entry:

```bash
# Remove subscription
curl -X POST "<BASE_URL>/app-subscription/delete" \
  -H "Authorization: ks <ADMIN_KS>" \
  -H "Content-Type: application/json" \
  -d '{"id": "<SUBSCRIPTION_ID>"}'

# Remove app-registry entry
curl -X POST "<BASE_URL>/app-registry/delete" \
  -H "Authorization: ks <ADMIN_KS>" \
  -H "Content-Type: application/json" \
  -d '{"appGuid": "<APP_GUID>"}'
```

## Security Notes

- KS tokens are stripped from the browser URL immediately after being read by the callback page (prevents exposure in browser history)
- The token paste field uses `type="password"` to prevent shoulder-surfing
- KS tokens are stored in UXP SecureStorage (OS-level encrypted keychain), never in localStorage
- The SPA Proxy endpoint is unauthenticated by design (same as KMC SSO) — it only initiates the IdP redirect, it doesn't return session tokens
- Session tokens have a 24-hour expiry with automatic refresh at 80% of TTL
