import { LitElement, html, css, nothing, type TemplateResult } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import {
  setFanModeCall,
  setFanMinOnTimeCall,
  setSwingModeCall,
  type FanIcon,
  type FanModel,
  type FanOption,
  type MinRuntimeModel,
  type SwingAxis,
  type SwingModel,
  type SwingOption,
} from '../climate/fan';
import { fanModeIcons, fanSpeedGlyph, icons } from '../icons';
import { emitServiceCall } from './service-call-event';
import { emitOverlayDismiss, reschedulePickerClose } from './overlay-dismiss';

/**
 * `<ecosee-fan-overlay>` — the Fan sub-screen's content (slotted into
 * <ecosee-overlay>). Laid out as the device is (see docs/reference/fan-mode.jpeg):
 * a "Fan Mode" title, then the On / Auto segmented pill toggle, then — when a
 * `fan_min_on_time` number entity is configured — the minimum-runtime helper copy
 * and its dropdown selector ("0 min / hr"). The active fan mode's segment is filled
 * cyan with dark text (the squircle "selected" motif); the rest are cyan on black.
 *
 * Like the System Mode picker (and unlike the Temperature Adjust overlay), this
 * owns no lasting edit state: each choice is a single discrete write. Selecting a
 * fan mode highlights it optimistically on tap (`_pending`, issue #38), emits the
 * shared `ecosee-service-call` with the `climate.set_fan_mode` call, then auto-closes
 * after a brief confirm beat (issue #39) — a correction tap during the beat re-points
 * the pick and restarts it, and tapping the already-active mode commits nothing but
 * still closes. The minimum-runtime dropdown is a secondary setting on the same
 * screen: choosing a runtime emits the same event with the `number.set_value` call
 * but keeps the screen open (so you can set runtime *and* a fan mode in one visit;
 * closing on a native-select change would also be jarring). A runtime change is
 * ignored once a fan-mode pick has started the closing beat.
 *
 * Swing: when the entity lists `swing_modes` (and/or `swing_horizontal_modes`), a
 * Swing selector follows the fan modes. With swing present the screen becomes a
 * multi-setting panel, so neither a fan-mode nor a swing pick auto-closes (you can
 * set both in one visit); each highlights optimistically until `hass` echoes the
 * value back, and the inactivity timer still returns the card Home.
 *
 * The body scrolls when its content outgrows the surface (many fan speeds + swing
 * + the runtime block, or the tab bar's reserved inset), instead of being clipped
 * by the shell's overflow:hidden. Taps on its empty areas still dismiss.
 */
/** The glyph for a fan-mode icon descriptor. */
function fanIconGlyph(icon: FanIcon): TemplateResult | ReturnType<typeof fanSpeedGlyph> {
  return icon.kind === 'speed' ? fanSpeedGlyph(icon.level, icon.of) : fanModeIcons[icon.kind];
}

@customElement('ecosee-fan-overlay')
export class EcoseeFanOverlay extends LitElement {
  /** The fan options + swing + optional runtime selector, derived by the host from `hass`. */
  @property({ attribute: false }) model?: FanModel;
  /** The bound climate entity the emitted calls target. */
  @property({ attribute: false }) entityId = '';
  /** The optimistically-chosen fan mode, set on tap so the segment fills before the
   *  device echoes back (issue #38); `null` until a pick (or once echoed, when the
   *  screen stays open). */
  @state() private _pending: string | null = null;
  /** Optimistically-chosen swing mode per axis, cleared once `hass` echoes it. */
  @state() private _pendingSwing: Partial<Record<SwingAxis, string>> = {};
  /** True once a fan-mode pick has started the closing beat (no-swing layout). */
  private _closing = false;
  /** Handle for the pending auto-close, cancelled if the overlay is torn down first. */
  private _closeTimer?: ReturnType<typeof setTimeout>;

  static override styles = css`
    :host {
      display: block;
      width: 100%;
      height: 100%;
    }

    /* Title near the top with the controls beneath (fan-mode.jpeg), not a
       vertically-centered cluster. Inline-size container so everything scales with
       cqw off the definite width, with the root's own padding/gap in the fixed unit (calc · --ecosee-u) so they can't couple to the viewport, the real bug — a container-type element resolves its OWN cqw against the viewport (issue #35).
       The root scrolls (hidden scrollbar, touch device) so tall content — many
       speeds, swing, the runtime block — is reachable rather than clipped by the
       shell; it reserves the tab bar's inset at the bottom when one is shown. */
    .fan {
      container-type: inline-size;
      box-sizing: border-box;
      width: var(--ecosee-base-size, 460px);
      height: var(--ecosee-base-size, 460px);
      display: flex;
      flex-direction: column;
      align-items: center;
      padding: calc(10 * var(--ecosee-u, 4.6px)) calc(9 * var(--ecosee-u, 4.6px))
        max(calc(7 * var(--ecosee-u, 4.6px)), var(--ecosee-tabbar-inset, 0px));
      text-align: center;
    }

    /* The scroll viewport, bounded between the name/✕ strip and the tab bar so
       scrolled content never slides under shell chrome; its edges fade out (the
       padding matches the fade so unscrolled content sits fully opaque). Opts back
       into pointer events so it can scroll; taps on its empty areas dismiss. */
    .scroll {
      flex: 1 1 auto;
      min-height: 0;
      width: 100%;
      box-sizing: border-box;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 5cqw;
      padding: 4cqw 0;
      overflow-y: auto;
      overscroll-behavior: contain;
      scrollbar-width: none;
      pointer-events: auto;
      -webkit-mask-image: linear-gradient(
        transparent,
        #000 4cqw,
        #000 calc(100% - 4cqw),
        transparent
      );
      mask-image: linear-gradient(transparent, #000 4cqw, #000 calc(100% - 4cqw), transparent);
    }
    .scroll::-webkit-scrollbar {
      display: none;
    }
    .scroll > * {
      flex: none;
    }

    .group {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 3.5cqw;
    }

    .title {
      margin: 0;
      font-size: 8cqw;
      font-weight: 600;
      letter-spacing: 0.02em;
      color: var(--ecosee-accent, #62cfe9);
    }

    /* The On / Auto segmented pill: a cyan-outlined pill holding the segments; the
       selected segment is a filled cyan rounded pill with dark text. Opts back into
       pointer events (the shell makes slotted content transparent so empty areas
       dismiss). */
    .toggle {
      display: inline-flex;
      align-items: stretch;
      border: 0.5cqw solid var(--ecosee-accent, #62cfe9);
      border-radius: 100cqw;
      padding: 1.2cqw;
      pointer-events: auto;
    }

    .segment {
      appearance: none;
      background: none;
      border: none;
      margin: 0;
      font: inherit;
      font-size: 7cqw;
      font-weight: 500;
      color: var(--ecosee-accent, #62cfe9);
      padding: 3cqw 9cqw;
      min-width: 22cqw;
      border-radius: 100cqw;
      cursor: pointer;
      white-space: nowrap;
    }
    .segment:focus-visible {
      outline: 0.5cqw solid var(--ecosee-accent, #62cfe9);
      outline-offset: 0.6cqw;
    }
    .segment.selected {
      background: var(--ecosee-accent, #62cfe9);
      color: var(--ecosee-bg, #0a0d10);
      cursor: default;
    }

    /* Multi-option layout (issue #44): past two options a horizontal pill gets
       cramped, and a single full-width column ran off the bottom of the surface,
       so lay them out as a two-column grid of capsule segments inside a rounded
       cyan-outlined panel (an odd last option spans both columns). Each segment
       keeps the same fill/outline language, so a two-mode fan is untouched. */
    .toggle.stacked {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 1.2cqw;
      width: 72cqw;
      max-width: 100%;
      box-sizing: border-box;
      border-radius: 7cqw;
    }
    .toggle.stacked .segment {
      min-width: 0;
      width: 100%;
      padding: 2.6cqw 2cqw;
      font-size: 6cqw;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .toggle.stacked .segment:last-child:nth-child(odd) {
      grid-column: 1 / -1;
    }

    /* Icon layout: compact glyph segments in a --cols-wide grid (one row up to
       five modes), the active one filled, with the active mode named below. */
    .toggle.icons {
      display: inline-grid;
      grid-template-columns: repeat(var(--cols, 4), auto);
      gap: 1.2cqw;
      border-radius: 9cqw;
    }
    .toggle.icons .segment {
      min-width: 0;
      padding: 2.4cqw 3.4cqw;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .toggle.icons .glyph {
      display: block;
      width: 8.5cqw;
      height: 8.5cqw;
    }
    .toggle.icons .glyph svg {
      display: block;
    }
    .caption {
      margin: -1.5cqw 0 0;
      font-size: 5.5cqw;
      font-weight: 500;
      color: var(--ecosee-accent, #62cfe9);
      opacity: 0.85;
    }
    .sr-only {
      position: absolute;
      width: 1px;
      height: 1px;
      overflow: hidden;
      clip: rect(0 0 0 0);
      white-space: nowrap;
    }

    /* With swing present the screen carries two selectors, so tighten the type. */
    .fan.dense .title {
      font-size: 6.5cqw;
    }
    .fan.dense .segment {
      font-size: 6cqw;
      padding: 2.4cqw 7cqw;
    }
    .fan.dense .toggle.stacked .segment {
      padding: 2.2cqw 2cqw;
      font-size: 5.5cqw;
    }

    /* Minimum-runtime block: bold summary line, instructional hint, then the
       dropdown selector. */
    .runtime {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 4cqw;
    }
    .summary {
      margin: 0;
      font-size: 6.5cqw;
      font-weight: 600;
      color: var(--ecosee-accent, #62cfe9);
    }
    .hint {
      margin: 0;
      font-size: 5.5cqw;
      font-weight: 400;
      line-height: 1.3;
      color: var(--ecosee-accent, #62cfe9);
      opacity: 0.85;
    }

    /* Cyan-outlined dropdown pill (fan-mode.jpeg). The visible label + ⌄ caret are
       driven by the model, with a transparent native <select> layered over the pill
       to capture taps and open the platform list. Sourcing the label from the model
       (rather than the select's own value) keeps the current runtime reflected on
       first open, sidestepping the <select> value-binding order in Lit. */
    .select-pill {
      position: relative;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 3cqw;
      margin-top: 1cqw;
      padding: 3cqw 7cqw;
      border: 0.5cqw solid var(--ecosee-accent, #62cfe9);
      border-radius: 100cqw;
      color: var(--ecosee-accent, #62cfe9);
      font-size: 6.5cqw;
      font-weight: 500;
    }
    .select-label {
      pointer-events: none;
    }
    .caret {
      width: 5cqw;
      height: 5cqw;
      flex: none;
      color: var(--ecosee-accent, #62cfe9);
      pointer-events: none;
    }
    .select-native {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      margin: 0;
      padding: 0;
      border: none;
      appearance: none;
      -webkit-appearance: none;
      background: none;
      color: transparent;
      font: inherit;
      opacity: 0;
      cursor: pointer;
      pointer-events: auto;
    }
    .select-pill:focus-within {
      outline: 0.5cqw solid var(--ecosee-accent, #62cfe9);
      outline-offset: 0.6cqw;
    }
    /* Best-effort skin for the native dropdown list (platform support varies). */
    .select-native option {
      color: var(--ecosee-fg, #d4eff9);
      background: var(--ecosee-bg, #0a0d10);
    }
  `;

  /** Drop optimistic picks once `hass` reports them, so the highlight follows the
   *  entity again (only relevant while the screen stays open after a pick). */
  protected override willUpdate(changed: Map<PropertyKey, unknown>): void {
    if (!changed.has('model') || !this.model) return;
    if (!this._closing && this._pending !== null) {
      const echoed = this.model.options.some((o) => o.selected && o.fanMode === this._pending);
      if (echoed) this._pending = null;
    }
    const next = { ...this._pendingSwing };
    let dirty = false;
    for (const swing of this.model.swing) {
      const pending = next[swing.axis];
      if (
        pending !== undefined &&
        swing.options.some((o) => o.selected && o.swingMode === pending)
      ) {
        delete next[swing.axis];
        dirty = true;
      }
    }
    if (dirty) this._pendingSwing = next;
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    if (this._closeTimer !== undefined) clearTimeout(this._closeTimer);
  }

  /** Whether a fan-mode pick closes the screen: only in the single-selector layout.
   *  With swing on the same screen it stays open so both can be set in one visit. */
  private get _pickCloses(): boolean {
    return (this.model?.swing.length ?? 0) === 0;
  }

  private _selectMode(option: FanOption): void {
    if (this._closing) {
      // A correction tap during the confirm beat re-points the pick and restarts it.
      if (this._pending === option.fanMode) return;
      this._pending = option.fanMode;
      emitServiceCall(this, setFanModeCall(option.fanMode, this.entityId));
      this._closeTimer = reschedulePickerClose(this, this._closeTimer);
      return;
    }
    const current = this._pending ?? this.model?.options.find((o) => o.selected)?.fanMode;
    const noChange = current === option.fanMode;
    if (!this._pickCloses) {
      if (noChange) return; // panel layout: nothing to write, nothing to close
      this._pending = option.fanMode;
      emitServiceCall(this, setFanModeCall(option.fanMode, this.entityId));
      return;
    }
    // Tapping the current fan mode: nothing to write, but honour "nothing left to
    // do" by closing anyway (issue #39).
    this._pending = option.fanMode; // fill / hold the segment now (issue #38)
    this._closing = true;
    if (!noChange) emitServiceCall(this, setFanModeCall(option.fanMode, this.entityId));
    this._closeTimer = reschedulePickerClose(this, this._closeTimer); // confirm beat, then close
  }

  private _selectSwing(swing: SwingModel, option: SwingOption): void {
    if (this._closing) return;
    const current =
      this._pendingSwing[swing.axis] ?? swing.options.find((o) => o.selected)?.swingMode;
    if (current === option.swingMode) return;
    this._pendingSwing = { ...this._pendingSwing, [swing.axis]: option.swingMode };
    emitServiceCall(this, setSwingModeCall(option.swingMode, swing.axis, this.entityId));
  }

  /** Taps on the body's empty areas (and its non-control text) dismiss, matching
   *  the shell backdrop that the now pointer-active scroll body covers. */
  private _onBodyClick(event: Event): void {
    const target = event.target as Element | null;
    if (target?.closest('button, select, .select-pill')) return;
    emitOverlayDismiss(this);
  }

  private _onRuntimeChange(event: Event, runtime: MinRuntimeModel): void {
    if (this._closing) return; // a fan-mode pick is settling — ignore
    const value = Number((event.target as HTMLSelectElement).value);
    if (!Number.isFinite(value) || value === runtime.value) return;
    emitServiceCall(this, setFanMinOnTimeCall(value, runtime.entityId));
  }

  override render(): TemplateResult | typeof nothing {
    const model = this.model;
    if (!model || !model.available) return nothing;
    const dense = model.swing.length > 0;
    return html`
      <div class="fan ${dense ? 'dense' : ''}">
        <div class="scroll" @click=${this._onBodyClick}>
          ${model.options.length > 0 ? this._renderFanModes(model.options) : nothing}
          ${model.swing.map((swing) => this._renderSwing(swing, model.swing.length > 1))}
          ${this._renderRuntime(model.minRuntime)}
        </div>
      </div>
    `;
  }

  private _renderFanModes(options: FanOption[]): TemplateResult {
    // While a pick is pending, the optimistic choice wins the fill; otherwise it
    // follows the entity's reported fan mode.
    const isSelected = (option: FanOption): boolean =>
      this._pending !== null ? option.fanMode === this._pending : option.selected;
    // Icon layout: when every mode has a glyph, the segments are compact icons in
    // one row (two rows past five), and the selected mode's name is captioned
    // beneath so the glyphs never have to be guessed. Any mode without a glyph
    // keeps the text layout: two modes in the horizontal pill, more as a
    // two-column N-way selector (issue #44).
    const iconic = options.every((option) => option.icon !== null);
    const layout = iconic ? 'icons' : options.length > 2 ? 'stacked' : '';
    const columns = options.length <= 5 ? options.length : Math.ceil(options.length / 2);
    const current = options.find(isSelected);
    return html`
      <div class="group">
        <h2 class="title">Fan Mode</h2>
        <div
          class="toggle ${layout}"
          role="group"
          aria-label="Fan Mode"
          style=${iconic ? `--cols: ${columns}` : ''}
        >
          ${options.map((option) => {
            const selected = isSelected(option);
            return html`
              <button
                class="segment ${selected ? 'selected' : ''}"
                aria-pressed=${selected}
                title=${option.label}
                @click=${() => this._selectMode(option)}
              >
                ${
                  iconic && option.icon
                    ? html`<span class="glyph">${fanIconGlyph(option.icon)}</span
                        ><span class="sr-only">${option.label}</span>`
                    : option.label
                }
              </button>
            `;
          })}
        </div>
        ${
          iconic
            ? html`<p class="caption" aria-hidden="true">${current?.label ?? '\u00a0'}</p>`
            : nothing
        }
      </div>
    `;
  }

  private _renderSwing(swing: SwingModel, bothAxes: boolean): TemplateResult {
    const title = bothAxes
      ? swing.axis === 'horizontal'
        ? 'Horizontal Swing'
        : 'Vertical Swing'
      : 'Swing';
    const pending = this._pendingSwing[swing.axis];
    const stacked = swing.options.length > 2;
    return html`
      <div class="group swing">
        <h2 class="title">${title}</h2>
        <div class="toggle ${stacked ? 'stacked' : ''}" role="group" aria-label=${title}>
          ${swing.options.map((option) => {
            const selected = pending !== undefined ? option.swingMode === pending : option.selected;
            return html`
              <button
                class="segment ${selected ? 'selected' : ''}"
                aria-pressed=${selected}
                @click=${() => this._selectSwing(swing, option)}
              >
                ${option.label}
              </button>
            `;
          })}
        </div>
      </div>
    `;
  }

  private _renderRuntime(runtime: MinRuntimeModel | null): TemplateResult | typeof nothing {
    if (!runtime) return nothing;
    const current = runtime.options.find((option) => option.selected);
    return html`
      <div class="runtime">
        <p class="summary">${runtime.summary}</p>
        <p class="hint">
          You can change your fan's minimum hourly runtime by tapping the setting below.
        </p>
        <div class="select-pill">
          <span class="select-label">${current?.label}</span>
          <span class="caret">${icons.caretDown}</span>
          <select
            class="select-native"
            aria-label="Minimum fan runtime"
            @change=${(event: Event) => this._onRuntimeChange(event, runtime)}
          >
            ${runtime.options.map(
              (option) =>
                html`<option value=${option.value} ?selected=${option.selected}>
                  ${option.label}
                </option>`,
            )}
          </select>
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'ecosee-fan-overlay': EcoseeFanOverlay;
  }
}
