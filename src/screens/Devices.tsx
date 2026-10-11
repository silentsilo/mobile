import { useCallback, useEffect, useState } from "react";
import { Laptop, Pencil, Smartphone } from "lucide-react";
import { api, type DeviceInfo } from "../api";
import { formatAppError } from "../shared/errors";
import { formatDate } from "../shared/format";
import { Notice, Sheet, Skeleton, TopBar, useToast } from "../ui/chrome";
import { t, useLocale } from "../i18n";

/** What a device is called: its given name, else what it calls itself. */
function nameOf(d: DeviceInfo): string {
  return d.label || d.system_name || t("silo.device_unnamed");
}

const PHONE = /android|ios|iphone|ipad/i;

/**
 * Every device that has changed this silo, as the computer lists them, with
 * when it last did. A name given here shows on every device.
 */
export function Devices({ onBack }: { onBack: () => void }) {
  useLocale();
  const [devices, setDevices] = useState<DeviceInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [naming, setNaming] = useState<DeviceInfo | null>(null);
  const [name, setName] = useState("");
  const toast = useToast();

  const load = useCallback(() => {
    api.listDevices().then(
      (all) => setDevices([...all].sort((a, b) => Number(b.is_this_device) - Number(a.is_this_device) || b.last_change_at - a.last_change_at)),
      (e) => setError(formatAppError(e)),
    );
  }, []);
  useEffect(load, [load]);

  const rename = async () => {
    if (!naming) return;
    try {
      await api.setDeviceLabel(naming.id, name);
      setNaming(null);
      load();
    } catch (e) {
      toast(formatAppError(e));
    }
  };

  return (
    <div className="screen">
      <TopBar onBack={onBack} backLabel={t("silo.tab_name")} title={t("silo.row_devices")} />
      <div className="screen-body tight" style={{ gap: 16 }}>
        <p className="hint" style={{ padding: "0 4px" }}>{t("silo.devices_hint")}</p>
        {error && <Notice tone="error">{error}</Notice>}
        {!devices && !error && <Skeleton avatar={false} rows={3} />}
        {devices && (
          <div className="panel">
            {devices.map((d, i) => {
              const Icon = PHONE.test(d.platform ?? "") ? Smartphone : Laptop;
              return (
                <button
                  key={d.id}
                  className={`row${i > 0 ? " divide" : ""}`}
                  style={{ minHeight: 64, width: "100%" }}
                  onClick={() => {
                    setName(d.label ?? "");
                    setNaming(d);
                  }}
                >
                  <Icon size={20} aria-hidden />
                  <span className="row-text">
                    <span className="row-title">
                      {nameOf(d)}
                      {d.is_this_device && <span className="muted small"> · {t("silo.device_this_phone")}</span>}
                    </span>
                    <span className="row-sub">
                      {[d.platform, d.last_change_at > 0 ? t("silo.device_last_change", { date: formatDate(d.last_change_at) }) : null]
                        .filter(Boolean)
                        .join(" · ")}
                    </span>
                  </span>
                  <Pencil size={16} aria-hidden color="var(--text-dim)" />
                </button>
              );
            })}
          </div>
        )}
      </div>

      <Sheet open={naming !== null} onClose={() => setNaming(null)} title={t("silo.device_rename")}>
        <div className="input">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={naming?.system_name ?? ""}
            autoCapitalize="words"
            autoFocus
            aria-label={t("silo.device_rename")}
          />
        </div>
        <button className="btn" onClick={() => void rename()}>
          {t("common.save")}
        </button>
        <button className="btn secondary" onClick={() => setNaming(null)}>
          {t("common.cancel")}
        </button>
      </Sheet>
    </div>
  );
}
