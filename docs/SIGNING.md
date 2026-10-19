# Internal Signing Guide — PrintNinja

How to sign PrintNinja builds for **free, internal use** (company PCs and phones),
without buying a code-signing certificate.

This replaces nothing in `docs/RELEASE.md`. It expands section 2 ("Sign app locally")
for the case where you do not have a paid certificate.

## What this does and does not give you

| | Self-signed (this guide) | Paid certificate / store |
|---|---|---|
| Cost | Free | Paid yearly (Windows) / one-off fee (Play Store) |
| Trusted on your company machines | Yes, after you install the `.cer` once | Yes |
| Trusted on any other machine | No (Windows still warns) | Yes |
| Good for | Internal tools, staff phones, pilots | Public or customer distribution |

If you later ship to customers outside the company, buy a certificate from a public
provider and publish through the Play Store. The steps below do not carry over to that.

## Rules for the secrets

- `scripts/certs/` holds the private files (`windows.pfx`, `printninja.keystore`).
  They are **never committed**. Check with `git check-ignore scripts/certs/windows.pfx`.
- Only the public `.cer` file is shared with other people or machines.
- Keep a backup of the `.pfx` and the keystore, and their passwords, in your password
  manager. Do not store passwords in the repo or in CI logs.
- **Android: if the keystore is lost, nobody can update the app.** Android only
  installs an update signed with the same key as the installed app, so every user would
  have to uninstall first. Back it up before the first release.

---

## Windows (MSI)

### 1. Create the certificate (once)

PowerShell, from the repo root:

```powershell
$cert = New-SelfSignedCertificate -Type CodeSigningCert `
  -Subject "CN=PrintNinja Internal" -KeyUsage DigitalSignature `
  -KeyAlgorithm RSA -KeyLength 3072 -HashAlgorithm SHA256 `
  -KeyExportPolicy Exportable -NotAfter (Get-Date).AddYears(5) `
  -CertStoreLocation Cert:\CurrentUser\My

$pw = ConvertTo-SecureString "choose-a-password" -AsPlainText -Force
Export-PfxCertificate -Cert $cert -FilePath scripts\certs\windows.pfx -Password $pw
Export-Certificate    -Cert $cert -FilePath scripts\certs\printninja-internal.cer
```

This produces:

- `windows.pfx`: private key plus certificate. Used only by you to sign.
- `printninja-internal.cer`: public certificate. Installed on the PCs that should trust
  your builds.

### 2. Build and sign the MSI

```powershell
pnpm exec tauri build --bundles msi

signtool sign /f scripts\certs\windows.pfx /p "choose-a-password" /fd sha256 `
  /tr http://timestamp.digicert.com /td sha256 `
  src-tauri\target\release\bundle\msi\*.msi
```

The `/tr` timestamp server is free. It proves the file was signed while the certificate
was valid, so the signature stays good after the certificate expires.

`signtool` comes with the Windows SDK. If it is not on your `PATH`, it is usually in
`C:\Program Files (x86)\Windows Kits\10\bin\<version>\x64\`.

### 3. Verify the signature

```powershell
signtool verify /pa /v src-tauri\target\release\bundle\msi\PrintNinja_*.msi
```

On your own machine this passes only if the certificate is trusted there (step 4).
On an untrusted machine you will see "A certificate chain processed, but terminated in a
root certificate which is not trusted". That is expected until step 4.

### 4. Make each internal PC trust it

Run once per PC in an **administrator** PowerShell, using only the `.cer`:

```powershell
Import-Certificate -FilePath printninja-internal.cer -CertStoreLocation Cert:\LocalMachine\Root
Import-Certificate -FilePath printninja-internal.cer -CertStoreLocation Cert:\LocalMachine\TrustedPublisher
```

For more than a few PCs, deploy the `.cer` with Group Policy or Intune instead of by
hand (Trusted Root Certification Authorities and Trusted Publishers).

After this, the installer shows "PrintNinja Internal" as the publisher instead of
"Unknown publisher". Windows SmartScreen may still ask on files freshly downloaded from
the internet; installing from a shared drive or via your software-distribution tool
avoids that.

### Renewal

The certificate above lasts 5 years. Before it expires, create a new one (step 1), sign
new builds with it, and roll out the new `.cer`. Builds already signed and timestamped
keep working.

---

## Android (APK / AAB)

### 1. Create a keystore (once)

```bash
keytool -genkeypair -v -keystore scripts/certs/printninja.keystore -alias printninja \
  -keyalg RSA -keysize 2048 -validity 10000
```

Remember the keystore password and the key password. See the warning above about
backing it up.

### 2. Build a release and sign it

CI builds a **debug** APK/AAB (see `.github/workflows/ci.yml`). For distribution, build a
release locally:

```bash
pnpm tauri android build --target aarch64 --apk
```

Then sign the result yourself. This works no matter how the Gradle project is
configured:

```bash
# align, then sign (use the unsigned release APK that the build produced)
zipalign -p -f 4 app-universal-release-unsigned.apk aligned.apk
apksigner sign --ks scripts/certs/printninja.keystore --ks-key-alias printninja aligned.apk
apksigner verify --verbose aligned.apk
```

`zipalign` and `apksigner` are in the Android SDK under
`build-tools/<version>/`. Sign **after** `zipalign`, never before.

The `ANDROID_KEYSTORE_*` environment variables listed in `docs/RELEASE.md` only help if
the Gradle project reads them. If you want builds to come out signed directly, add a
signing config to the Android Gradle project that reads them, and check the result with
`apksigner verify`.

An `.aab` is only needed for the Play Store. Sign it with `jarsigner` using the same
keystore if you ever need one.

### 3. Install on phones

Give the signed APK to staff (shared drive, MDM, or direct download from a trusted
internal page). Each phone must allow "Install unknown apps" for the app used to open
the file (browser or file manager). An MDM can push the APK without that prompt.

Updates work as long as every build is signed with the **same keystore**.

---

## Not the same thing: the Tauri updater key

`TAURI_SIGNING_PRIVATE_KEY` in `docs/RELEASE.md` is for Tauri's built-in auto-updater
signatures. It is separate from the code signing above and is only needed if the app uses
the updater. Do not reuse the Windows `.pfx` or the Android keystore for it.

## Checklist before each release

- [ ] `scripts/certs/` files exist and are not tracked by git
- [ ] MSI signed, `signtool verify` passes on a machine with the `.cer` installed
- [ ] APK signed with the same keystore as the previous release, `apksigner verify` passes
- [ ] Signed files replace the unsigned CI files in the draft GitHub Release
- [ ] Install the MSI and the APK on one clean device each and open the app
