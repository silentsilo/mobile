import { Check, LockKeyhole, Plus } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../api";
import { formatAppError } from "../shared/errors";
import { Sheet, useToast } from "../ui/chrome";

type Choice = { id: string; name: string; active: boolean; unlocked: boolean };

/** Tells the app shell the silo in front changed, or a new one is wanted. */
export function announceSilo(what: "switched" | "add" | "create") {
  window.dispatchEvent(new CustomEvent("silo-choice", { detail: what }));
}

export function SiloSwitcher({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [silos, setSilos] = useState<Choice[] | null>(null);
  const toast = useToast();

  useEffect(() => {
    if (open) api.listSilos().then(setSilos, (e) => toast(formatAppError(e)));
  }, [open, toast]);

  const choose = async (silo: Choice) => {
    if (silo.active) return onClose();
    try {
      await api.switchSilo(silo.id);
      onClose();
      announceSilo("switched");
    } catch (e) {
      toast(formatAppError(e));
    }
  };

  return (
    <Sheet open={open} onClose={onClose} title="Silos on this phone">
      <div className="panel">
        {silos?.map((silo, i) => (
          <button key={silo.id} className={`row${i ? " divide" : ""}`} style={{ minHeight: 56 }} onClick={() => void choose(silo)}>
            <span className="row-title" style={{ flex: 1 }}>{silo.name}</span>
            {!silo.unlocked && <LockKeyhole size={16} color="var(--text-dim)" aria-label="Locked" />}
            {silo.active && <Check size={20} color="var(--accent-hover)" aria-label="Current" />}
          </button>
        ))}
      </div>
      <button
        className="btn secondary"
        onClick={() => {
          onClose();
          announceSilo("add");
        }}
      >
        <Plus size={18} />
        Join another silo
      </button>
      <button
        className="btn secondary"
        onClick={() => {
          onClose();
          announceSilo("create");
        }}
      >
        <Plus size={18} />
        Make a new silo
      </button>
    </Sheet>
  );
}
