import { useEffect, useRef, useState } from "react";
import { Upload } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AppLogo } from "@/components/AppLogo";
import { usePrefs } from "@/lib/prefs/PrefsProvider";
import { DEFAULT_APP_NAME, MAX_APP_NAME_LENGTH, checkLogoFile, type Density } from "@/lib/prefs/prefs";
import { cn } from "@/lib/utils";

const DENSITIES: Array<{ value: Density; label: string; hint: string }> = [
  { value: "comfortable", label: "Comfortable", hint: "Larger controls and roomier tables. Default." },
  { value: "compact", label: "Compact", hint: "Smaller controls and tighter tables, to see more rows." },
];

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
  const { density, appName, logo, setDensity, setAppName, setLogo } = usePrefs();
  const [name, setName] = useState(appName);
  const [logoError, setLogoError] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => setName(appName), [appName]);

  const saveName = async () => {
    if (name.trim() === appName) return;
    await setAppName(name);
    toast.success("Name saved");
  };

  const pickLogo = async (file: File) => {
    const check = checkLogoFile(file);
    if (!check.ok) {
      setLogoError(check.message);
      return;
    }
    setLogoError("");
    try {
      await setLogo(await readAsDataUrl(file));
      toast.success("Logo saved");
    } catch {
      setLogoError("That image could not be read.");
    }
  };

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Density</CardTitle>
        </CardHeader>
        <CardContent>
          <div role="radiogroup" aria-label="Density" data-testid="settings-density" className="grid gap-2 sm:grid-cols-2">
            {DENSITIES.map((d) => {
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
                    selected ? "border-primary bg-accent" : "border-input bg-card hover:bg-muted",
                  )}
                >
                  <span className="block font-medium">{d.label}</span>
                  <span className="block text-sm text-muted-foreground">{d.hint}</span>
                </button>
              );
            })}
          </div>
          <p className="mt-2 text-xs text-muted-foreground">Touch screens always use the larger controls.</p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Branding</CardTitle>
          <p className="text-sm text-muted-foreground">
            Optional. Shown in the top bar, the window title, and the welcome screen.
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="brand-name">App name</Label>
            <Input
              id="brand-name"
              data-testid="settings-brand-name"
              value={name}
              maxLength={MAX_APP_NAME_LENGTH}
              placeholder={DEFAULT_APP_NAME}
              onChange={(e) => setName(e.target.value)}
              onBlur={saveName}
              onKeyDown={(e) => { if (e.key === "Enter") void saveName(); }}
            />
          </div>

          <div className="space-y-1.5">
            <Label>Logo</Label>
            <div className="flex flex-wrap items-center gap-3">
              <AppLogo src={logo} className="h-10 w-10" />
              <input
                ref={fileRef}
                type="file"
                aria-label="Upload logo file"
                tabIndex={-1}
                accept="image/png,image/jpeg,image/webp,image/svg+xml"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void pickLogo(f);
                  e.target.value = "";
                }}
              />
              <Button variant="outline" data-testid="settings-logo-upload" onClick={() => fileRef.current?.click()}>
                <Upload className="h-4 w-4" aria-hidden="true" />
                Upload logo
              </Button>
              {logo && (
                <Button variant="ghost" onClick={async () => { await setLogo(null); toast.success("Logo removed"); }}>
                  Remove logo
                </Button>
              )}
            </div>
            <p className="text-xs text-muted-foreground">Square works best. PNG, JPEG, WebP, or SVG, up to 256 KB.</p>
            {logoError && <p role="alert" className="text-sm text-danger">{logoError}</p>}
          </div>

          {(appName !== DEFAULT_APP_NAME || logo) && (
            <Button
              variant="outline"
              onClick={async () => {
                await setAppName(DEFAULT_APP_NAME);
                await setLogo(null);
                toast.success("Branding reset");
              }}
            >
              Reset to {DEFAULT_APP_NAME}
            </Button>
          )}
        </CardContent>
      </Card>
    </>
  );
}
