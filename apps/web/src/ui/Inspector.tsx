import { useEffect, useMemo, useState } from "react";
import { clearanceCheckType, displayName, ercExclusionEntry, exclusionEntry } from "@crossprobe/kicad-model";
import type { EditOp } from "../edit/ops";
import type { ComponentInfo, ProjectView } from "../render/types";
import { Icon } from "./icons";
import { BoardFootprintCard, PadCard } from "./PadCard";
import { OverflowTabs } from "./OverflowTabs";
import { FootprintChooser, footprintOps } from "./FootprintChooser";
import { DatasheetPanel } from "./DatasheetPanel";
import { fieldOps } from "./fields";
import { ReviewPanel } from "./ReviewPanel";
import type { Selection } from "./selection";
import { extensionTabs, installed } from "../extensions";

/** The inspector's own tabs, or an extension's (by its id). */
export type Tab = "components" | "nets" | "issues" | "review" | "datasheet" | (string & {});

/** The Review tab's label: an extension that adds to it (an assistant's review) may name it. */
const REVIEW_TAB = installed.find((e) => e.reviewTab)?.reviewTab ?? {
  title: "Requirements and compatibility checks",
  label: <>Requirements</>,
  menuLabel: <>Requirements</>,
  className: undefined,
};
/** Tabs that show a panel instead of the list (and the selection card only when they ask for it). */
const PANEL_TABS = new Set<string>(["review", "datasheet", ...extensionTabs.map((t) => t.id)]);
const SELECTION_TABS = new Set<string>(["review", ...extensionTabs.filter((t) => t.showsSelection).map((t) => t.id)]);

const ISSUE_LABELS: Record<string, string> = {
  missing_footprint: "Missing footprint",
  extra_footprint: "Extra footprint",
  duplicate_footprints: "Duplicate footprints",
  footprint_symbol_mismatch: "Footprint ≠ symbol",
  footprint_symbol_field_mismatch: "Field differs",
  net_conflict: "Net conflict",
};

const LIMIT = 400;

/** One-click fixes for common ERC findings (the app applies them as ordinary, undoable edits). */
const QUICK_FIXES: Record<string, { label: string; title: string } | undefined> = {
  pin_not_connected: { label: "No-connect", title: "Mark the pin as intentionally unconnected (a no-connect flag on it)" },
  power_pin_not_driven: { label: "Add PWR_FLAG", title: "Place a PWR_FLAG on this pin: it tells ERC the net is powered (e.g. from a connector or battery)" },
};

const DRC_LABELS: Record<string, string> = {
  drill_out_of_range: "Hole size",
  annular_width: "Annular ring",
  track_dangling: "Dangling tracks",
  via_dangling: "Dangling vias",
  courtyards_overlap: "Courtyards overlap",
  holes_co_located: "Holes drilled twice",
  hole_to_hole: "Holes too close",
  starved_thermal: "Starved thermal reliefs",
  text_height: "Silkscreen text too small",
  text_thickness: "Silkscreen text too thin",
  track_width: "Track width",
  via_diameter: "Via diameter",
  mirrored_text_on_front_layer: "Mirrored text on the front",
  nonmirrored_text_on_back_layer: "Unmirrored text on the back",
  silk_edge_clearance: "Silkscreen at the board edge",
  silk_over_copper: "Silkscreen over exposed copper",
  solder_mask_bridge: "Solder mask bridges nets",
  silk_overlap: "Silkscreen overlaps silkscreen",
  items_not_allowed: "Item in a keep-out area",
  pth_inside_courtyard: "Plated hole in another part's courtyard",
  npth_inside_courtyard: "Unplated hole in another part's courtyard",
  zones_intersect: "Zones of one net and priority overlap",
  footprint_type_mismatch: "Footprint type doesn't match its pads",
  length_out_of_range: "Trace length out of range (custom rule)",
  skew_out_of_range: "Skew between traces out of range (custom rule)",
  diff_pair_gap_out_of_range: "Differential pair gap out of range (custom rule)",
  diff_pair_uncoupled_length_too_long: "Differential pair uncoupled too long (custom rule)",
};

const ERC_LABELS: Record<string, string> = {
  pin_to_pin: "Pin conflicts",
  pin_not_driven: "Input pin not driven",
  power_pin_not_driven: "Power input not driven",
  pin_not_connected: "Pin not connected",
  no_connect_connected: "No-connect flag on a connected pin",
  no_connect_dangling: "Unconnected no-connect flag",
  label_dangling: "Label not connected",
  isolated_pin_label: "Label connected to only one pin",
  label_multiple_wires: "Label joins several wires",
  wire_dangling: "Wire not connected",
  unconnected_wire_endpoint: "Unconnected wire end",
  endpoint_off_grid: "Off connection grid",
  multiple_net_names: "Several names for one net",
  similar_labels: "Labels differ only in case",
  hier_label_mismatch: "Sheet pin without a label, or label without a pin",
  missing_unit: "Units not placed",
  missing_input_pin: "Input pins in units not placed",
  missing_bidi_pin: "Bidirectional pins in units not placed",
  missing_power_pin: "Supply pins in units not placed",
  different_unit_footprint: "Units of one part with different footprints",
  duplicate_sheet_names: "Two sheets with one name",
  same_local_global_label: "Local and global label with one name",
  unresolved_variable: "Text variable that names nothing",
  single_global_label: "Global label that appears only once",
  field_name_whitespace: "Field name with spaces around it",
  similar_label_and_power: "Label and power net differ only in case",
  similar_power: "Power nets differ only in case",
  undefined_netclass: "Net class not in the project",
  ground_pin_not_ground: "Ground pin off the ground net",
  different_unit_net: "A pin shared by units on different nets",
  bus_to_net_conflict: "Bus and net connected directly",
  net_not_bus_member: "Wire on a bus entry that isn't a bus member",
  duplicate_reference: "Duplicate reference",
};

/** An input that applies its value on Enter or when focus leaves it. */
function FieldInput({ value, onCommit, mono }: { value: string; onCommit: (v: string) => void; mono?: boolean }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  const commit = () => v !== value && onCommit(v);
  return (
    <input
      className={`field-input${mono ? " mono" : ""}`}
      value={v}
      onChange={(e) => setV(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        if (e.key === "Escape") {
          setV(value);
          (e.target as HTMLInputElement).blur();
        }
      }}
    />
  );
}

/** Field edits for every placed unit of a component. */

export function Inspector({
  project,
  selection,
  onSelect,
  onOpenSheet,
  editing = false,
  boardEditing = false,
  onEdit,
  onQuickFix,
  onNoConnectAll,
  onEditFootprint,
  onEditSymbol,
  onPlaceUnits,
  openTab,
  onWide,
}: {
  /** Switch to a tab; a new object each time it should take effect. */
  openTab?: { tab: Tab };
  /** The datasheet tab wants more room: the app widens this panel while it is on. */
  onWide?: (wide: boolean) => void;
  editing?: boolean;
  /** The PCB is being edited (pad properties become editable). */
  boardEditing?: boolean;
  onEdit?: (ops: EditOp[]) => void;
  /** Apply a one-click fix for an ERC finding (editing only). */
  onQuickFix?: (v: import("@crossprobe/kicad-model").ErcViolation) => void;
  /** Open a symbol (by "Library:Name") in the symbol editor. */
  onEditSymbol?: (libId: string) => void;
  /** Place a part's units that aren't on the schematic yet (in order). */
  onPlaceUnits?: (c: ComponentInfo, units: number[]) => void;
  /** Open a footprint (by "Library:Name") in the footprint editor. */
  onEditFootprint?: (libId: string) => void;
  /** No-connect flags on all the listed unconnected pins at once. */
  onNoConnectAll?: (list: import("@crossprobe/kicad-model").ErcViolation[]) => void;
  project: ProjectView;
  selection: Selection;
  onSelect: (s: Selection) => void;
  onOpenSheet: (path: string) => void;
}) {
  const [tab, setTab] = useState<Tab>("components");
  // Opened from elsewhere (e.g. a button in the top bar).
  useEffect(() => {
    onWide?.(tab === "datasheet" || extensionTabs.some((t) => t.id === tab && t.wide));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);
  useEffect(() => {
    if (openTab) setTab(openTab.tab);
  }, [openTab]);
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const sheetName = useMemo(() => new Map(project.sheets.map((s) => [s.path, s.namePath])), [project]);

  const components = useMemo(
    () =>
      project.components.filter(
        (c) => !q || c.reference.toLowerCase().includes(q) || c.value.toLowerCase().includes(q) || c.footprint.toLowerCase().includes(q),
      ),
    [project, q],
  );
  const nets = useMemo(
    () => project.nets.filter((n) => !q || [n.name, ...n.aliases].some((a) => a.toLowerCase().includes(q) || displayName(a).toLowerCase().includes(q))),
    [project, q],
  );
  const [issueFilter, setIssueFilter] = useState<"all" | "erc" | "board">("all");
  /** "Exclude" on a DRC finding: kept in the project file with a reason, as KiCad's DRC exclusions are. */
  const excludeButton = (type: string, at: { x: number; y: number }, items: Array<{ uuid?: string }>) =>
    onEdit && project.projectFile && items.some((it) => it.uuid) ? (
      <button
        className="quick-fix"
        title="Accept this finding on purpose: it moves to Excluded (saved in the project file, as KiCad does)"
        onClick={() => {
          const comment = window.prompt("Why is this fine? (kept with the exclusion)", "");
          if (comment === null) return;
          onEdit([{ op: "setProjectRules", file: project.projectFile!, exclude: { entry: exclusionEntry(type, at, items), comment } }]);
        }}
      >
        Exclude
      </button>
    ) : null;
  const [errorsOnly, setErrorsOnly] = useState(false);
  const [choosingFootprint, setChoosingFootprint] = useState<string>();
  const footprintFor = choosingFootprint ? project.components.find((c) => c.reference === choosingFootprint) : undefined;
  const issues = useMemo(
    () =>
      project.parity.filter(
        (f) => (!errorsOnly || f.severity === "error") && (!q || f.reference.toLowerCase().includes(q) || f.message.toLowerCase().includes(q)),
      ),
    [project, q, errorsOnly],
  );
  const ercIssues = useMemo(
    () =>
      project.erc.filter(
        (v) =>
          (!errorsOnly || v.severity === "error") &&
          (!q || v.message.toLowerCase().includes(q) || v.items.some((i) => i.description.toLowerCase().includes(q))),
      ),
    [project, q, errorsOnly],
  );
  const ercGroups = useMemo(() => {
    const m = new Map<string, typeof ercIssues>();
    for (const v of ercIssues) m.set(v.type, [...(m.get(v.type) ?? []), v]);
    // Errors first, then by size.
    return [...m.entries()].sort(
      (a, b) => Number(b[1].some((v) => v.severity === "error")) - Number(a[1].some((v) => v.severity === "error")) || b[1].length - a[1].length,
    );
  }, [ercIssues]);

  const selectedComponent = selection?.kind === "component" ? project.components.find((c) => c.reference === selection.reference) : undefined;
  const selectedNet = selection?.kind === "net" ? project.nets.find((n) => n.name === selection.name) : undefined;
  // The footprint on the board, for a picked pad and for board-only parts (holes, logos).
  const selectedFootprint = selection?.kind === "component" ? project.board?.footprints.find((f) => f.reference === selection.reference) : undefined;
  const selectedPad = selection?.kind === "component" ? selection.pad : undefined;
  const componentPins = useMemo(() => {
    if (!selectedComponent) return [];
    const out: Array<{ pin: string; pinName: string; net: string }> = [];
    for (const n of project.nets) for (const node of n.nodes) if (node.reference === selectedComponent.reference) out.push({ pin: node.pin, pinName: node.pinName, net: n.name });
    return out.sort((a, b) => a.pin.localeCompare(b.pin, "en", { numeric: true }));
  }, [project, selectedComponent]);

  const issueLevel =
    project.erc.some((v) => v.severity === "error") || project.clearance.length || project.boardChecks.some((v) => v.severity === "error")
      ? " err"
      : project.parity.length + project.erc.length + project.boardChecks.length
        ? " warn"
        : "";
  const issueCount = (
    <span className={`count${issueLevel}`}>{project.parity.length + project.erc.length + project.unconnected.length + project.clearance.length + project.boardChecks.length}</span>
  );

  return (
    <aside className="inspector">
      {/* In order of importance: what doesn't fit goes under "⋯" from the end. */}
      <OverflowTabs<Tab>
        active={tab}
        onSelect={setTab}
        items={[
          { id: "components", title: "Components", label: <>Parts <span className="count">{project.components.length}</span></>, menuLabel: <>Parts <span className="count">{project.components.length}</span></> },
          { id: "nets", title: "Nets", label: <>Nets <span className="count">{project.nets.length}</span></>, menuLabel: <>Nets <span className="count">{project.nets.length}</span></> },
          {
            id: "issues",
            title: "Issues: ERC, DRC, unrouted, schematic/PCB parity",
            label: <>Issues {issueCount}</>,
            menuLabel: <>Issues {issueCount}</>,
            attention: issueLevel === " err",
          },
          { id: "review", className: REVIEW_TAB.className, title: REVIEW_TAB.title, label: REVIEW_TAB.label, menuLabel: REVIEW_TAB.menuLabel },
          { id: "datasheet", title: "Datasheet: find the page that says it", label: <><Icon name="doc" /> <span className="tl">Datasheet</span></>, menuLabel: <><Icon name="doc" /> Datasheet</> },
          ...extensionTabs.map((t) => ({ id: t.id, className: t.className, title: t.title, label: t.label, menuLabel: t.menuLabel })),
        ]}
      />
      {(selectedComponent || selectedNet || selectedFootprint) && (!PANEL_TABS.has(tab) || SELECTION_TABS.has(tab)) && (
        <div className="selection-card">
          <button className="icon-btn close" title="Clear selection (Esc)" onClick={() => onSelect(null)}>
            <Icon name="close" />
          </button>
      {selectedFootprint && selectedPad !== undefined && (
        <PadCard
          footprint={selectedFootprint}
          pad={selectedPad}
          onSelect={onSelect}
          edit={boardEditing && onEdit && project.boardFile ? { file: project.boardFile, nets: project.board?.nets ?? [], onEdit } : undefined}
        />
      )}
      {selectedFootprint && !selectedComponent && <BoardFootprintCard footprint={selectedFootprint} onEditFootprint={onEditFootprint} />}
      {selectedComponent && (
        <section className="detail">
          <header>
            <span className="kind">Component</span>
            <h2>{selectedComponent.reference}</h2>
            <span className="muted">{selectedComponent.value}</span>
          </header>
          {selectedComponent.description && !editing && <p className="desc">{selectedComponent.description}</p>}
          {editing && (
            <div className="field-editor">
              {[
                "Reference",
                "Value",
                "Footprint",
                "Datasheet",
                "Description",
                ...Object.keys(selectedComponent.properties).filter(
                  (k) => !["Reference", "Value", "Footprint", "Datasheet", "Description"].includes(k) && !k.startsWith("ki_"),
                ),
              ].map((name) => (
                <label key={name}>
                  <span>{name}</span>
                  <FieldInput
                    mono={name === "Footprint" || name === "Reference"}
                    value={name === "Reference" ? selectedComponent.reference : (selectedComponent.properties[name] ?? "")}
                    onCommit={(v) => {
                      onEdit?.(fieldOps(selectedComponent, name, v));
                      if (name === "Reference") onSelect({ kind: "component", reference: v });
                    }}
                  />
                  {name === "Footprint" && (
                    <button
                      className={`field-btn${selectedComponent.footprint ? "" : " attention"}`}
                      onClick={(e) => {
                        e.preventDefault();
                        setChoosingFootprint(selectedComponent.reference);
                      }}
                      title="Browse KiCad's footprints, filtered for this symbol"
                    >
                      <Icon name="search" />
                    </button>
                  )}
                  {name in selectedComponent.properties && (
                    <input
                      type="checkbox"
                      className="field-shown"
                      title={`Show ${name} on the sheet`}
                      aria-label={`Show ${name} on the sheet`}
                      checked={!selectedComponent.hiddenFields.includes(name)}
                      onChange={(e) => onEdit?.(selectedComponent.units.map((u) => ({ op: "setFieldVisible" as const, file: u.file, uuid: u.uuid, name, visible: e.target.checked })))}
                    />
                  )}
                </label>
              ))}
              <button
                className="link"
                onClick={() => {
                  const name = window.prompt("New field name (e.g. MPN, Manufacturer)");
                  if (name) onEdit?.(fieldOps(selectedComponent, name, ""));
                }}
              >
                + Add field
              </button>
              <div className="symbol-flags">
                {(
                  [
                    ["dnp", "Do not populate", selectedComponent.dnp, "Left off the board at assembly; kept in the design"],
                    ["inBom", "In the BOM", selectedComponent.inBom, "Listed in the bill of materials"],
                    ["onBoard", "On the board", selectedComponent.onBoard, "Gets a footprint when the PCB is updated"],
                    ["excludeFromSim", "Exclude from simulation", selectedComponent.excludeFromSim, "Left out of SPICE netlists"],
                  ] as const
                ).map(([key, text, on, title]) => (
                  <label key={key} title={title}>
                    <input type="checkbox" checked={on} onChange={(e) => onEdit?.(selectedComponent.units.map((u) => ({ op: "setSymbolAttributes" as const, file: u.file, uuid: u.uuid, [key]: e.target.checked })))} />
                    {text}
                  </label>
                ))}
              </div>
              {selectedComponent.bodyStyles.length > 1 && (
                <label>
                  <span>Body style</span>
                  <select
                    className="field-input"
                    value={selectedComponent.bodyStyle}
                    onChange={(e) => onEdit?.(selectedComponent.units.map((u) => ({ op: "setBodyStyle" as const, file: u.file, uuid: u.uuid, style: Number(e.target.value) })))}
                  >
                    {selectedComponent.bodyStyles.map((n, i) => (
                      <option key={n} value={i + 1}>{n}</option>
                    ))}
                  </select>
                </label>
              )}
            </div>
          )}
          <dl className={editing ? "compact" : undefined}>
            <dt>Footprint</dt>
            <dd className="mono one-line" title={selectedComponent.footprint}>
              {selectedComponent.footprint || "—"}
              {onEditFootprint && selectedComponent.footprint && (
                <>
                  {" "}
                  <button className="link" onClick={() => onEditFootprint(selectedComponent.footprint)} title="Open it in the footprint editor (a library footprint is copied into the project's footprint library first)">
                    Edit footprint
                  </button>
                </>
              )}
            </dd>
            <dt>Symbol</dt>
            <dd className="mono one-line" title={selectedComponent.libId}>
              {selectedComponent.libId}
              {onEditSymbol && (
                <>
                  {" "}
                  <button className="link" onClick={() => onEditSymbol(selectedComponent.libId)} title="Open it in the symbol editor (a library symbol is copied into the project's symbol library first)">
                    Edit symbol
                  </button>
                </>
              )}
            </dd>
            {selectedComponent.unitCount > 1 &&
              (() => {
                const c = selectedComponent;
                const letter = (u: number) => String.fromCharCode(64 + u);
                const placed = new Set(c.units.map((u) => u.unit));
                const missing = Array.from({ length: c.unitCount }, (_, i) => i + 1).filter((u) => !placed.has(u));
                return (
                  <>
                    <dt>Units</dt>
                    <dd>
                      {[...placed].sort((a, b) => a - b).map(letter).join(", ")} of {c.unitCount}
                      {onPlaceUnits && missing.length > 0 && (
                        <>
                          {" "}
                          <button className="link" onClick={() => onPlaceUnits(c, missing)} title={`Place ${missing.map((u) => c.reference + letter(u)).join(", ")} with the place tool, one click each`}>
                            Place {missing.length > 1 ? `${letter(missing[0]!)}–${letter(missing[missing.length - 1]!)}` : letter(missing[0]!)}
                          </button>
                        </>
                      )}
                    </dd>
                  </>
                );
              })()}
            {selectedComponent.datasheet && selectedComponent.datasheet !== "~" && (
              <>
                <dt>Datasheet</dt>
                <dd>
                  <button className="link" onClick={() => setTab("datasheet")} title="Find the page that says it, in the datasheet">
                    Find in it
                  </button>{" "}
                  {/^(https?:|www\.)/.test(selectedComponent.datasheet) ? (
                    <a
                      href={/^www\./.test(selectedComponent.datasheet) ? `https://${selectedComponent.datasheet}` : selectedComponent.datasheet}
                      target="_blank"
                      rel="noreferrer"
                      title={selectedComponent.datasheet}
                    >
                      Open ↗
                    </a>
                  ) : (
                    <span className="mono">{selectedComponent.datasheet}</span>
                  )}
                </dd>
              </>
            )}
            <dt>Sheet</dt>
            <dd>
              {selectedComponent.sheets.map((s) => (
                <button key={s} className="link" onClick={() => onOpenSheet(s)}>
                  {sheetName.get(s)}
                </button>
              ))}
            </dd>
            {(selectedComponent.dnp || !selectedComponent.inBom || !selectedComponent.onBoard) && (
              <>
                <dt>Flags</dt>
                <dd>
                  {[selectedComponent.dnp && "DNP", !selectedComponent.inBom && "not in BOM", !selectedComponent.onBoard && "not on board"].filter(Boolean).join(", ")}
                </dd>
              </>
            )}
            {Object.entries(selectedComponent.properties)
              .filter(([k, v]) => v && !["Reference", "Value", "Footprint", "Datasheet", "Description"].includes(k) && !k.startsWith("ki_"))
              .slice(0, 12)
              .map(([k, v]) => (
                <div key={k} className="row">
                  <dt>{k}</dt>
                  <dd className="one-line" title={v}>{v}</dd>
                </div>
              ))}
          </dl>
          {componentPins.length > 0 && (
            <>
              <h3>Pins</h3>
              <ul className="pins">
                {componentPins.map((p) => (
                  <li key={p.pin}>
                    <span className="mono pin">{p.pin}</span>
                    {(() => {
                      // A pin with alternate functions: pick which one it is (editing), or see the one chosen.
                      const alt = selectedComponent.pinAlternates.find((a) => a.pin === p.pin);
                      if (!alt || !editing) return <span className="pinname">{alt?.current ?? (p.pinName !== "~" ? p.pinName : "")}</span>;
                      return (
                        <select
                          className="pinname pin-alternate"
                          title="This pin's function"
                          value={alt.current ?? ""}
                          onChange={(e) =>
                            onEdit?.(selectedComponent.units.map((u) => ({ op: "setPinAlternate" as const, file: u.file, uuid: u.uuid, pin: p.pin, alternate: e.target.value || null })))
                          }
                        >
                          <option value="">{alt.name}</option>
                          {alt.alternates.map((a) => (
                            <option key={a} value={a}>{a}</option>
                          ))}
                        </select>
                      );
                    })()}
                    <button className="link net" onClick={() => onSelect({ kind: "net", name: p.net })}>
                      {displayName(p.net)}
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      )}
      {selectedNet && (
        <section className="detail">
          <header>
            <span className="kind">Net</span>
            <h2 className="mono">{displayName(selectedNet.name)}</h2>
            <span className="muted">{selectedNet.nodes.length} pins</span>
          </header>
          {selectedNet.aliases.length > 1 && (
            <p className="desc">
              Also: <span className="mono">{selectedNet.aliases.filter((a) => a !== selectedNet.name).map(displayName).join(", ")}</span>
            </p>
          )}
          <dl>
            <dt>Sheets</dt>
            <dd>
              {selectedNet.sheets.map((s) => (
                <button key={s} className="link" onClick={() => onOpenSheet(s)}>
                  {sheetName.get(s)}
                </button>
              ))}
            </dd>
          </dl>
          <ul className="pins">
            {selectedNet.nodes.slice(0, 200).map((n) => (
              <li key={`${n.reference}:${n.pin}`}>
                <button className="link" onClick={() => onSelect({ kind: "component", reference: n.reference })}>
                  {n.reference}
                </button>
                <span className="mono pin">{n.pin}</span>
                <span className="pinname">{n.pinName !== "~" ? n.pinName : ""}</span>
                <span className="muted small">{n.pinType}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
        </div>
      )}

      <ReviewPanel project={project} onSelect={onSelect} onEdit={onEdit} hidden={tab !== "review"} />
      <DatasheetPanel project={project} selection={selection} onEdit={onEdit} hidden={tab !== "datasheet"} />
      {extensionTabs.map(({ id, Panel }) => (
        <Panel key={id} project={project} selection={selection} selectedComponent={selectedComponent} onSelect={onSelect} onEdit={onEdit} hidden={tab !== id} />
      ))}
      {!PANEL_TABS.has(tab) && (
            <div className="search-box">
        <Icon name="search" className="muted" />
        <input id="inspector-search" className="search" placeholder="Search…  ( / )" value={query} onChange={(e) => setQuery(e.target.value)} />
      </div>
      )}
      <div className="list" style={PANEL_TABS.has(tab) ? { display: "none" } : undefined}>
        {tab === "components" &&
          components.slice(0, LIMIT).map((c) => (
            <button
              key={c.reference}
              className={`item${selection?.kind === "component" && selection.reference === c.reference ? " on" : ""}`}
              onClick={() => onSelect({ kind: "component", reference: c.reference })}
            >
              <span className="ref">{c.reference}</span>
              <span className="val">{c.value}</span>
              {c.footprint ? (
                <span className="fp" title={c.footprint}>
                  {c.footprint.split(":").pop()}
                </span>
              ) : (
                <span className="tag warn" title="No footprint assigned">no footprint</span>
              )}
              {c.dnp && <span className="tag">DNP</span>}
              {project.evidence.some((e) => e.target.reference === c.reference) && (
                <span className="tag ds" title="Datasheet evidence is pinned to this part">
                  <Icon name="doc" />
                </span>
              )}
            </button>
          ))}
        {tab === "nets" &&
          nets.slice(0, LIMIT).map((n) => (
            <button
              key={n.name}
              className={`item${selection?.kind === "net" && selection.name === n.name ? " on" : ""}`}
              onClick={() => onSelect({ kind: "net", name: n.name })}
            >
              <span className="val mono">{displayName(n.name)}</span>
              <span className="muted small">{n.nodes.length}</span>
            </button>
          ))}
        {tab === "issues" && (
          <>
            <div className="chips">
              {(["all", "erc", "board"] as const).map((k) => (
                <button key={k} className={issueFilter === k ? "on" : ""} onClick={() => setIssueFilter(k)}>
                  {k === "all" ? "All" : k === "erc" ? `ERC ${ercIssues.length}` : `Board ${issues.length + project.unconnected.length + project.clearance.length + project.boardChecks.length}`}
                </button>
              ))}
              <label className="chip-toggle">
                <input type="checkbox" checked={errorsOnly} onChange={(e) => setErrorsOnly(e.target.checked)} /> Errors only
              </label>
            </div>
            {issueFilter !== "board" &&
              ercGroups.map(([type, list]) => (
                <details key={type} className="issue-group" open={ercGroups.length <= 3}>
                  <summary>
                    <span className={`sev ${list.some((v) => v.severity === "error") ? "error" : "warning"}`} />
                    {ERC_LABELS[type] ?? type} <span className="muted small">{list.length}</span>
                    {type === "pin_not_connected" && onNoConnectAll && list.length > 1 && (
                      <button
                        className="quick-fix group-fix"
                        title="Put a no-connect flag on every pin listed here (one undoable edit)"
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          onNoConnectAll(list);
                        }}
                      >
                        No-connect all
                      </button>
                    )}
                  </summary>
                  {list.slice(0, LIMIT).map((v, i) => (
                    <div key={i} className="issue-row">
                      <button
                        className={`item issue${selection?.kind === "marker" && selection.sheet === v.sheet && selection.at.x === v.items[0]!.at.x && selection.at.y === v.items[0]!.at.y ? " on" : ""}`}
                        onClick={() => onSelect({ kind: "marker", sheet: v.sheet, at: v.items[0]!.at, label: v.message })}
                      >
                        <span className={`sev ${v.severity}`} />
                        <span className="val">
                          {v.items.map((it) => it.description).join(" · ")}
                          <span className="muted small"> — {v.sheetName}</span>
                        </span>
                      </button>
                      {onQuickFix && QUICK_FIXES[v.type] && (
                        <button className="quick-fix" onClick={() => onQuickFix(v)} title={QUICK_FIXES[v.type]!.title}>
                          {QUICK_FIXES[v.type]!.label}
                        </button>
                      )}
                      {onEdit && project.projectFile && (
                        <button
                          className="quick-fix"
                          title="Accept this finding on purpose: it moves to Excluded (saved in the project file, as KiCad does)"
                          onClick={() => {
                            const comment = window.prompt("Why is this fine? (kept with the exclusion)", "");
                            if (comment !== null) onEdit([{ op: "setErcExclusions", file: project.projectFile!, exclude: { entry: ercExclusionEntry(v), comment } }]);
                          }}
                        >
                          Exclude
                        </button>
                      )}
                    </div>
                  ))}
                </details>
              ))}
            {issueFilter !== "board" && project.ercExcluded.length > 0 && (
              <details className="issue-group">
                <summary>
                  <span className="sev excluded" />
                  Excluded (ERC) <span className="muted small">{project.ercExcluded.length}</span>
                </summary>
                {project.ercExcluded.slice(0, LIMIT).map((v, i) => (
                  <div key={i} className="issue-row">
                    <button className="item issue" onClick={() => onSelect({ kind: "marker", sheet: v.sheet, at: v.items[0]!.at, label: v.message })} title={v.comment || undefined}>
                      <span className="sev excluded" />
                      <span className="val muted">
                        <b>{ERC_LABELS[v.type] ?? v.type}</b> {v.items.map((it) => it.description).join(" · ")}
                        {v.comment && <span className="small"> — {v.comment}</span>}
                      </span>
                    </button>
                    {onEdit && project.projectFile && (
                      <button className="quick-fix" title="Check this again (removes the exclusion from the project file)" onClick={() => onEdit([{ op: "setErcExclusions", file: project.projectFile!, include: v.entries }])}>
                        Include
                      </button>
                    )}
                  </div>
                ))}
              </details>
            )}
            {issueFilter !== "erc" && project.clearance.length > 0 && (
              <details className="issue-group" open>
                <summary>
                  <span className="sev error" />
                  Clearance (DRC) <span className="muted small">{project.clearance.length}</span>
                </summary>
                {project.unsupportedRules.length > 0 && (
                  <p className="muted small issue-note">
                    Custom rules: clearance rules are applied; {project.unsupportedRules.join(", ")} aren't checked yet.
                  </p>
                )}
                {project.clearance.slice(0, LIMIT).map((v, i) => (
                  <div key={i} className="issue-row">
                    <button
                      className={`item issue${selection?.kind === "marker" && selection.sheet === "board" && selection.at.x === v.at.x && selection.at.y === v.at.y ? " on" : ""}`}
                      onClick={() => onSelect({ kind: "marker", sheet: "board", at: v.at, label: `${v.items[0].description} ↔ ${v.items[1].description}` })}
                    >
                      <span className="sev error" />
                      <span className="val">
                        <b>{v.type === "short" ? "Short" : `${v.actual.toFixed(3)} < ${v.required.toFixed(3)} mm`}</b> {v.items[0].description} ↔ {v.items[1].description}
                        <span className="muted small"> · {v.layer}</span>
                      </span>
                    </button>
                    {excludeButton(clearanceCheckType(v.type), v.at, v.items)}
                  </div>
                ))}
              </details>
            )}
            {issueFilter !== "erc" &&
              Object.entries(
                project.boardChecks.reduce<Record<string, typeof project.boardChecks>>((g, v) => ((g[v.type] ??= []).push(v), g), {}),
              ).map(([type, list]) => (
                <details key={type} className="issue-group" open={list.some((v) => v.severity === "error")}>
                  <summary>
                    <span className={`sev ${list.some((v) => v.severity === "error") ? "error" : "warning"}`} />
                    {DRC_LABELS[type] ?? type} <span className="muted small">{list.length}</span>
                  </summary>
                  {list.slice(0, LIMIT).map((v, i) => (
                    <div key={i} className="issue-row">
                      <button
                        className={`item issue${selection?.kind === "marker" && selection.sheet === "board" && selection.at.x === v.at.x && selection.at.y === v.at.y ? " on" : ""}`}
                        onClick={() => onSelect({ kind: "marker", sheet: "board", at: v.at, label: `${v.message}: ${v.items.map((it) => it.description).join(" ↔ ")}` })}
                      >
                        <span className={`sev ${v.severity}`} />
                        <span className="val">
                          <b>{v.message}</b> {v.items.map((it) => it.description).join(" ↔ ")}
                        </span>
                      </button>
                      {onEdit && project.boardFile && (v.type === "track_dangling" || v.type === "via_dangling") && v.items[0]?.uuid && (
                        <button className="quick-fix" title="Delete this leftover piece of copper" onClick={() => onEdit([{ op: "boardDelete", file: project.boardFile!, uuids: [v.items[0]!.uuid!] }])}>
                          Delete
                        </button>
                      )}
                      {excludeButton(v.type, v.at, v.items)}
                    </div>
                  ))}
                </details>
              ))}
            {issueFilter !== "erc" && project.drcExcluded.length > 0 && (
              <details className="issue-group">
                <summary>
                  <span className="sev excluded" />
                  Excluded (DRC) <span className="muted small">{project.drcExcluded.length}</span>
                </summary>
                {project.drcExcluded.slice(0, LIMIT).map((v, i) => (
                  <div key={i} className="issue-row">
                    <button className="item issue" onClick={() => onSelect({ kind: "marker", sheet: "board", at: v.at, label: `${v.message}: ${v.items.join(" ↔ ")}` })}>
                      <span className="sev excluded" />
                      <span className="val muted">
                        <b>{DRC_LABELS[v.type] ?? v.type}</b> {v.message} · {v.items.join(" ↔ ")}
                      </span>
                    </button>
                    {onEdit && project.projectFile && (
                      <button className="quick-fix" title="Check this again (removes the exclusion from the project file)" onClick={() => onEdit([{ op: "setProjectRules", file: project.projectFile!, include: v.key }])}>
                        Include
                      </button>
                    )}
                  </div>
                ))}
              </details>
            )}
            {issueFilter !== "erc" && project.unconnected.length > 0 && (
              <details className="issue-group" open>
                <summary>
                  <span className="sev error" />
                  Unrouted connections <span className="muted small">{project.unconnected.length}</span>
                </summary>
                {project.unconnected.slice(0, LIMIT).map((u, i) => (
                  <div key={i} className="issue-row">
                    <button className="item issue" onClick={() => onSelect({ kind: "net", name: u.net })}>
                      <span className="sev error" />
                      <span className="val">
                        <b className="mono">{displayName(u.net)}</b> {u.a.description} → {u.b.description}
                      </span>
                    </button>
                    {onEdit && project.boardFile && (
                      <button
                        className="quick-fix"
                        title="Route this connection automatically (one layer, around other nets' copper); check the result"
                        onClick={() => onEdit([{ op: "autoroute", file: project.boardFile!, connections: [{ from: u.a.at, to: u.b.at, net: u.net }] }])}
                      >
                        Route
                      </button>
                    )}
                  </div>
                ))}
              </details>
            )}
            {issueFilter !== "erc" && issues.length > 0 && (
              <details className="issue-group" open>
                <summary>
                  <span className="sev warning" />
                  Board ↔ schematic <span className="muted small">{issues.length}</span>
                </summary>
                {issues.slice(0, LIMIT).map((f, i) => (
                  <button key={i} className="item issue" onClick={() => f.reference && onSelect({ kind: "component", reference: f.reference })}>
                    <span className={`sev ${f.severity}`} />
                    <span className="ref">{f.reference || "—"}</span>
                    <span className="val">
                      <b>{ISSUE_LABELS[f.type] ?? f.type}</b> {f.message}
                    </span>
                  </button>
                ))}
              </details>
            )}
            {ercIssues.length === 0 && issues.length === 0 && project.unconnected.length === 0 && project.clearance.length === 0 && project.boardChecks.length === 0 && (
              <p className="empty">{project.board ? "No ERC issues, and schematic and board are in sync." : "No ERC issues."}</p>
            )}
          </>
        )}
        {((tab === "components" && components.length > LIMIT) || (tab === "nets" && nets.length > LIMIT)) && (
          <p className="empty">Showing first {LIMIT}. Refine the search to see more.</p>
        )}
      </div>
      {footprintFor && (
        <FootprintChooser
          component={footprintFor}
          components={project.components}
          onClose={() => setChoosingFootprint(undefined)}
          onChoose={(id, also) => {
            onEdit?.([footprintFor, ...also].flatMap((c) => footprintOps(c, id)));
            setChoosingFootprint(undefined);
          }}
        />
      )}
    </aside>
  );
}
