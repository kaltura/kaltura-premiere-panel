# Enterprise Deployment Guide

## Overview

This guide covers deploying the Kaltura for Adobe Creative Cloud plugin in enterprise environments using Adobe's supported distribution mechanisms.

**Reference:** [Install a UXP plugin — Premiere Pro](https://developer.adobe.com/premiere-pro/uxp/plugins/distribution/install/)

## Distribution Channels

| Channel       | Method                              | Use Case                      |
| ------------- | ----------------------------------- | ----------------------------- |
| Independent   | Double-click `.ccx` file            | Individual users, small teams |
| UPIA CLI      | Command-line install                | IT automation, scripting      |
| Admin Console | Managed package with plugins folder | Enterprise-wide deployment    |

## Installation Methods

### Double-Click Install

Download the `.ccx` file for your host app from the [latest release](https://github.com/kaltura/kaltura-premiere-panel/releases/latest) and double-click to install. The Creative Cloud Desktop application handles installation automatically.

| File                                  | Host App     |
| ------------------------------------- | ------------ |
| `kaltura-panel-x.x.x_premierepro.ccx` | Premiere Pro |
| `kaltura-panel-x.x.x_photoshop.ccx`   | Photoshop    |

After installation: **Window > UXP Plugins > Kaltura**.

> **Note:** Creative Cloud Desktop must be installed for double-click `.ccx` installation to work. UXP plugins cannot be copied directly into plugin directories — they must be installed via double-click or UPIA to correctly register in Adobe's plugin database. ([Source](https://blog.developer.adobe.com/en/publish/2022/03/how-to-install-uxp-plugins-using-command-line-tools))

### UPIA Command-Line Installation

The **UnifiedPluginInstallerAgent (UPIA)** is Adobe's command-line tool for plugin installation. It is included with Creative Cloud Desktop and is also automatically included in Adobe Enterprise installation workflows.

> UPIA is not available for separate download. It is bundled with Creative Cloud Desktop or with Enterprise deployment packages.

**macOS:**

```bash
cd "/Library/Application Support/Adobe/Adobe Desktop Common/RemoteComponents/UPI/UnifiedPluginInstallerAgent/UnifiedPluginInstallerAgent.app/Contents/macOS"

# Install
./UnifiedPluginInstallerAgent --install "/path/to/kaltura-panel-1.18.1_premierepro.ccx"

# List all installed plugins
./UnifiedPluginInstallerAgent --list all

# Remove (uses the plugin name from manifest.json)
./UnifiedPluginInstallerAgent --remove "Kaltura"
```

**Windows:**

```cmd
cd "C:\Program Files\Common Files\Adobe\Adobe Desktop Common\RemoteComponents\UPI\UnifiedPluginInstallerAgent"

REM Install
UnifiedPluginInstallerAgent.exe /install "C:\path\to\kaltura-panel-1.18.1_premierepro.ccx"

REM List all installed plugins
UnifiedPluginInstallerAgent.exe /list all

REM Remove (uses the plugin name from manifest.json)
UnifiedPluginInstallerAgent.exe /remove "Kaltura"
```

**Reference:** [Adobe — How to install UXP plugins using command-line tools](https://blog.developer.adobe.com/en/publish/2022/03/how-to-install-uxp-plugins-using-command-line-tools) and [Premiere Pro — Install a UXP plugin](https://developer.adobe.com/premiere-pro/uxp/plugins/distribution/install/)

### Adobe Admin Console (Managed Packages)

For enterprise-wide deployment to user groups:

1. Sign in to [Adobe Admin Console](https://adminconsole.adobe.com/)
2. Navigate to **Packages** > **Admin Packages**
3. Click **Create a Package** > **Managed Package**
4. Select target Adobe apps (Premiere Pro and/or Photoshop)
5. On the **Options** screen, enable **"Create a folder for extensions and include the UPIA command-line tool"**
6. Complete package creation
7. Place the `.ccx` file(s) in the generated Plugins folder:
   - **macOS:** `<package name>/Build/<PackageName>_Install.pkg/Contents/Resources/Plugins`
   - **Windows:** `<package name>\Build\Plugins`
8. Deploy the package via your IT distribution tool (SCCM, Jamf, Intune, etc.)

> **Note:** The plugins you include do not require the host application to be in the same package — they work with previously installed Adobe apps. ([Source](https://helpx.adobe.com/enterprise/using/manage-extensions.html))

> **Limitation:** Adding plugins to packages is not currently supported for Windows ARM devices.

**Reference:** [Adobe — Including plugins in your package](https://helpx.adobe.com/enterprise/using/manage-extensions.html)

## Building Packages

To build `.ccx` files locally:

```bash
npm run build
node scripts/build-ccx.js
```

This outputs one `.ccx` per host app into `release/`. Each `.ccx` targets a single host application (UXP requirement — the `host` property must be a single object). ([Source](https://developer.adobe.com/premiere-pro/uxp/plugins/distribution/package/))

Alternatively, push a version tag (e.g., `git tag v1.18.1 && git push --tags`) to trigger the automated [Release workflow](../.github/workflows/release.yml) which builds all `.ccx` files and publishes them as GitHub Release assets.

## Network Requirements

Configure corporate firewalls and proxy servers to allow access to:

| Domain             | Purpose                                                             |
| ------------------ | ------------------------------------------------------------------- |
| `*.kaltura.com`    | Kaltura REST API and thumbnail CDN (all 6 SaaS regions — see below) |
| `*.akamaihd.net`   | Akamai CDN (video/asset delivery)                                   |
| `*.cloudfront.net` | CloudFront CDN (video/asset delivery)                               |

Kaltura's multi-tenant SaaS runs in 6 regions, all reachable under `*.kaltura.com`:

| Region                  | Server URL                   |
| ----------------------- | ---------------------------- |
| United States (default) | `https://www.kaltura.com`    |
| Germany                 | `https://api.de.kaltura.com` |
| Ireland / EU            | `https://api.eu.kaltura.com` |
| Singapore               | `https://api.sg.kaltura.com` |
| Canada                  | `https://api.ca.kaltura.com` |
| Australia               | `https://api.ap.kaltura.com` |

Accounts on a **private cloud or on-premises** deployment use an account-specific URL that doesn't match any of the patterns above — get it from your Kaltura account manager or system administrator, and enter it as the "Custom" server option on the Login panel.

Because the private cloud/on-prem case has no predictable domain, the plugin's `manifest.json` declares `requiredPermissions.network.domains: "all"` rather than a fixed list — UXP's manifest permissions are static (set at install time, no runtime prompt), so a fixed list would break for any account not on the 6 known SaaS regions. In practice the plugin only ever contacts the single server URL configured on the Login panel; firewall rules only need to allow that one domain, not "all" domains.

The manifest also declares `wss://` access for a real-time notification feature that exists in the codebase but isn't wired into any panel yet — it carries no traffic today and needs no firewall allowance.

## Plugin Configuration

Users configure their Kaltura server URL and authenticate via the login screen (email/password or SSO) on first launch. Session tokens are stored securely in UXP SecureStorage and persist across sessions.

Settings (preferences, cache) are managed via **Window > UXP Plugins > Kaltura > Settings**.

## Troubleshooting

### Plugin not appearing in Window menu

- Verify host app version meets the minimum: **Premiere Pro v25.6+**, **Photoshop v25.1+**
- Ensure Creative Cloud Desktop is running
- Try reinstalling via UPIA: `--remove "Kaltura"` then `--install` the `.ccx`
- Check UXP Developer Tool console for errors

### Authentication failures

- Verify the Kaltura server URL and partner ID on the login screen
- Check network connectivity to `*.kaltura.com` endpoints
- For SSO: verify SSO provider configuration in Kaltura KMC admin settings

### Plugin appears duplicated

- Each `.ccx` targets one host app. Ensure you installed only the `.ccx` for your app.
- Use `--list all` to check what's installed, `--remove "Kaltura"` to clean up, then reinstall the correct `.ccx`.
