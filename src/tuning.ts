/**
 * Live tuning panel.
 *
 * This exists to *diagnose*, not to fix. The "dark face" could come from three
 * different places — the camera's own exposure, the texture as drawn, or the
 * scene lighting applied to a lit material — and they look identical on screen.
 * Separate sliders for each let you find which one actually moves the problem.
 *
 * Values persist in localStorage so a reload keeps whatever you were trying.
 */

export type Param = {
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  /** Rendered next to the value, e.g. "×" or "px". */
  suffix?: string;
  hint?: string;
};

export type Group = { title: string; note?: string; params: Record<string, Param> };

const STORE_KEY = "facehangout.tuning.v1";

export class Tuning<G extends Record<string, Group>> {
  private root: HTMLDivElement;
  private listeners: Array<() => void> = [];
  private visible = false;

  constructor(readonly groups: G) {
    this.load();
    this.root = this.build();
    document.body.appendChild(this.root);
    this.setVisible(false);
    addEventListener("keydown", (e) => {
      if (e.code === "KeyT" && !/input|textarea/i.test((e.target as HTMLElement)?.tagName ?? "")) {
        this.setVisible(!this.visible);
      }
    });
  }

  /** Current value of a parameter, by group and key. */
  get(group: keyof G, key: string): number {
    return this.groups[group].params[key].value;
  }

  onChange(fn: () => void): void {
    this.listeners.push(fn);
  }

  private emit(): void {
    this.save();
    for (const fn of this.listeners) fn();
  }

  setVisible(v: boolean): void {
    this.visible = v;
    this.root.style.display = v ? "block" : "none";
  }

  private load(): void {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (!raw) return;
      const saved = JSON.parse(raw) as Record<string, Record<string, number>>;
      for (const g of Object.keys(this.groups)) {
        for (const k of Object.keys(this.groups[g].params)) {
          const v = saved[g]?.[k];
          if (typeof v === "number" && Number.isFinite(v)) this.groups[g].params[k].value = v;
        }
      }
    } catch {
      /* corrupt or blocked storage is not worth failing over */
    }
  }

  private save(): void {
    try {
      const out: Record<string, Record<string, number>> = {};
      for (const g of Object.keys(this.groups)) {
        out[g] = {};
        for (const k of Object.keys(this.groups[g].params)) out[g][k] = this.groups[g].params[k].value;
      }
      localStorage.setItem(STORE_KEY, JSON.stringify(out));
    } catch {
      /* private mode; tuning just won't persist */
    }
  }

  /** Everything, as JSON — paste this back when you find settings that work. */
  snapshot(): Record<string, Record<string, number>> {
    const out: Record<string, Record<string, number>> = {};
    for (const g of Object.keys(this.groups)) {
      out[g] = {};
      for (const k of Object.keys(this.groups[g].params)) out[g][k] = this.groups[g].params[k].value;
    }
    return out;
  }

  reset(): void {
    try {
      localStorage.removeItem(STORE_KEY);
    } catch { /* ignore */ }
    location.reload();
  }

  private build(): HTMLDivElement {
    const root = document.createElement("div");
    root.id = "tuning";
    root.innerHTML = `<style>
      #tuning { position: fixed; top: 12px; right: 12px; width: 288px; max-height: 92vh;
        overflow-y: auto; background: rgba(12,15,22,.9); border: 1px solid #232a38;
        border-radius: 8px; padding: 12px; color: #e8ecf4; z-index: 20;
        font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; backdrop-filter: blur(8px); }
      #tuning h2 { font-size: 12px; text-transform: uppercase; letter-spacing: .08em;
        color: #7c8798; margin: 0 0 8px; }
      #tuning h3 { font-size: 10px; text-transform: uppercase; letter-spacing: .07em;
        color: #5eead4; margin: 14px 0 2px; padding-top: 8px; border-top: 1px solid #232a38; }
      #tuning .note { color: #667085; font-size: 10px; margin-bottom: 6px; }
      #tuning .p { margin: 7px 0; }
      #tuning .lab { display: flex; justify-content: space-between; gap: 8px; }
      #tuning .lab b { font-weight: 400; color: #98a2b3; }
      #tuning .lab i { font-style: normal; color: #e8ecf4; }
      #tuning input[type=range] { width: 100%; margin: 2px 0 0; accent-color: #5eead4; }
      #tuning .hint { color: #667085; font-size: 10px; }
      #tuning .btns { display: flex; gap: 6px; margin-top: 12px; }
      #tuning button { flex: 1; background: #232a38; color: #e8ecf4; border: 0;
        border-radius: 5px; padding: 6px; font: inherit; cursor: pointer; }
      #tuning button:hover { background: #2f3949; }
    </style><h2>Tuning &nbsp;<span style="color:#667085">T to hide</span></h2>`;

    for (const gKey of Object.keys(this.groups)) {
      const g = this.groups[gKey];
      const h = document.createElement("h3");
      h.textContent = g.title;
      root.appendChild(h);
      if (g.note) {
        const n = document.createElement("div");
        n.className = "note";
        n.textContent = g.note;
        root.appendChild(n);
      }
      for (const pKey of Object.keys(g.params)) {
        const p = g.params[pKey];
        const wrap = document.createElement("div");
        wrap.className = "p";
        const lab = document.createElement("div");
        lab.className = "lab";
        const val = document.createElement("i");
        const fmt = () => (val.textContent = `${p.value}${p.suffix ?? ""}`);
        lab.innerHTML = `<b>${p.label}</b>`;
        lab.appendChild(val);
        fmt();
        const input = document.createElement("input");
        input.type = "range";
        input.min = String(p.min);
        input.max = String(p.max);
        input.step = String(p.step);
        input.value = String(p.value);
        input.addEventListener("input", () => {
          p.value = Number(input.value);
          fmt();
          this.emit();
        });
        wrap.appendChild(lab);
        wrap.appendChild(input);
        if (p.hint) {
          const hint = document.createElement("div");
          hint.className = "hint";
          hint.textContent = p.hint;
          wrap.appendChild(hint);
        }
        root.appendChild(wrap);
      }
    }

    const btns = document.createElement("div");
    btns.className = "btns";
    const copy = document.createElement("button");
    copy.textContent = "Copy JSON";
    copy.onclick = () => {
      const j = JSON.stringify(this.snapshot(), null, 2);
      console.log("[tuning]", this.snapshot());
      navigator.clipboard?.writeText(j).catch(() => {});
      copy.textContent = "Copied";
      setTimeout(() => (copy.textContent = "Copy JSON"), 1200);
    };
    const reset = document.createElement("button");
    reset.textContent = "Reset";
    reset.onclick = () => this.reset();
    btns.appendChild(copy);
    btns.appendChild(reset);
    root.appendChild(btns);
    return root;
  }
}
