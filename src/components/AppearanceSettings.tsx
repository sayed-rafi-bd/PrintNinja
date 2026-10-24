import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Upload } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AppLogo } from "@/components/AppLogo";
import { SUPPORTED_LANGUAGES, currentLanguage, setLanguage } from "@/lib/i18n";
import { usePrefs } from "@/lib/prefs/PrefsProvider";
import {
  DEFAULT_APP_NAME,
  MAX_APP_NAME_LENGTH,
  checkLogoFile,
  type Density,
} from "@/lib/prefs/prefs";
import { cn } from "@/lib/utils";

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

/** Density and optional branding. Both apply immediately and are stored in settings. */
export function AppearanceSettings() {
  // useTranslation re-renders this component when the language changes.
  const { t } = useTranslation();
  const language = currentLanguage();
  const { density, appName, logo, setDensity, setAppName, setLogo } =
    usePrefs();
  const [name, setName] = useState(appName);
  const [logoError, setLogoError] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  const densities: Array<{ value: Density; label: string; hint: string }> = [
    {
      value: "comfortable",
      label: t("settings_page.appearance_density_comfortable"),
      hint: t("settings_page.appearance_density_comfortable_hint"),
    },
    {
      value: "compact",
      label: t("settings_page.appearance_density_compact"),
      hint: t("settings_page.appearance_density_compact_hint"),
    },
  ];

  useEffect(() => setName(appName), [appName]);

  const saveName = async () => {
    if (name.trim() === appName) return;
    await setAppName(name);
    toast.success(t("settings_page.appearance_name_saved"));
  };

  const pickLogo = async (file: File) => {
    const check = checkLogoFile(file);
    if (!check.ok) {
      setLogoError(t(check.messageKey, check.messageValues));
      return;
    }
    setLogoError("");
    try {
      await setLogo(await readAsDataUrl(file));
      toast.success(t("settings_page.appearance_logo_saved"));
    } catch {
      setLogoError(t("settings_page.appearance_logo_unreadable"));
    }
  };

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            {t("settings_page.appearance_language")}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div
            role="radiogroup"
            aria-label={t("settings_page.appearance_language")}
            data-testid="settings-language"
            className="grid gap-2 sm:grid-cols-2"
          >
            {SUPPORTED_LANGUAGES.map((l) => {
              const selected = language === l.code;
              return (
                <button
                  key={l.code}
                  type="button"
                  role="radio"
                  lang={l.code}
                  aria-checked={selected}
                  data-testid={`settings-language-${l.code}`}
                  onClick={() => void setLanguage(l.code)}
                  className={cn(
                    "rounded-md border p-3 text-left font-medium transition-colors",
                    selected
                      ? "border-primary bg-accent"
                      : "border-input bg-card hover:bg-muted",
                  )}
                >
                  {l.label}
                </button>
              );
            })}
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            {t("settings_page.appearance_language_hint")}
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            {t("settings_page.appearance_density")}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div
            role="radiogroup"
            aria-label={t("settings_page.appearance_density")}
            data-testid="settings-density"
            className="grid gap-2 sm:grid-cols-2"
          >
            {densities.map((d) => {
              const selected = density === d.value;
              return (
                <button
                  key={d.value}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  onClick={() => setDensity(d.value)}
                  className={cn(
                    "rounded-md border p-3 text-left transition-colors",
                    selected
                      ? "border-primary bg-accent"
                      : "border-input bg-card hover:bg-muted",
                  )}
                >
                  <span className="block font-medium">{d.label}</span>
                  <span className="block text-sm text-muted-foreground">
                    {d.hint}
                  </span>
                </button>
              );
            })}
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            {t("settings_page.appearance_density_note")}
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            {t("settings_page.appearance_branding")}
          </CardTitle>
          <p className="text-sm text-muted-foreground">
            {t("settings_page.appearance_branding_hint")}
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="brand-name">
              {t("settings_page.appearance_app_name")}
            </Label>
            <Input
              id="brand-name"
              data-testid="settings-brand-name"
              value={name}
              maxLength={MAX_APP_NAME_LENGTH}
              placeholder={DEFAULT_APP_NAME}
              onChange={(e) => setName(e.target.value)}
              onBlur={saveName}
              onKeyDown={(e) => {
                if (e.key === "Enter") void saveName();
              }}
            />
          </div>

          <div className="space-y-1.5">
            <Label>{t("settings_page.appearance_logo")}</Label>
            <div className="flex flex-wrap items-center gap-3">
              <AppLogo src={logo} className="h-10 w-10" />
              <input
                ref={fileRef}
                type="file"
                aria-label={t("settings_page.appearance_upload_logo_label")}
                tabIndex={-1}
                accept="image/png,image/jpeg,image/webp,image/svg+xml"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void pickLogo(f);
                  e.target.value = "";
                }}
              />
              <Button
                variant="outline"
                data-testid="settings-logo-upload"
                onClick={() => fileRef.current?.click()}
              >
                <Upload className="h-4 w-4" aria-hidden="true" />
                {t("settings_page.appearance_upload_logo")}
              </Button>
              {logo && (
                <Button
                  variant="ghost"
                  onClick={async () => {
                    await setLogo(null);
                    toast.success(t("settings_page.appearance_logo_removed"));
                  }}
                >
                  {t("settings_page.appearance_remove_logo")}
                </Button>
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              {t("settings_page.appearance_logo_hint")}
            </p>
            {logoError && (
              <p role="alert" className="text-sm text-danger">
                {logoError}
              </p>
            )}
          </div>

          {(appName !== DEFAULT_APP_NAME || logo) && (
            <Button
              variant="outline"
              onClick={async () => {
                await setAppName(DEFAULT_APP_NAME);
                await setLogo(null);
                toast.success(t("settings_page.appearance_branding_reset"));
              }}
            >
              {t("settings_page.appearance_reset", { name: DEFAULT_APP_NAME })}
            </Button>
          )}
        </CardContent>
      </Card>
    </>
  );
}
