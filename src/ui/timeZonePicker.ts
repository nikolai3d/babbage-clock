/**
 * Searchable IANA timezone picker.
 *
 * A native `<select>` with four hundred options is unusable, and a component
 * library is out (owner decision: vanilla TS). So this is the standard combobox
 * pattern built by hand on real elements — an `<input role="combobox">` and a
 * `<ul role="listbox">` — with arrow-key navigation, `aria-activedescendant`,
 * and no focus trap: Tab always leaves.
 *
 * Free text is accepted as well as list entries, because `resolveTarget` also
 * takes fixed offsets (`+05:30`) and `UTC`; anything `isValidTimeZone` rejects
 * reverts to the last good value on blur rather than being silently kept.
 */

import { isValidTimeZone } from '../time/target.js';
import { filterTimeZones, findTimeZone, listTimeZones, zoneOffset } from './timeZones.js';
import type { TimeZoneOption } from './timeZones.js';

export interface TimeZonePickerOptions {
  readonly inputId: string;
  readonly initialZone: string;
  /** Instant used to label each zone with the offset in effect then. */
  readonly referenceMs: number;
  /** Called on every committed change, never on intermediate typing. */
  readonly onChange?: (zone: string) => void;
}

const MAX_RESULTS = 40;

export class TimeZonePicker {
  /** The wrapper to place in a field; contains the input and the listbox. */
  readonly root: HTMLDivElement;
  readonly input: HTMLInputElement;

  private readonly list: HTMLUListElement;
  private readonly listboxId: string;
  private readonly referenceMs: number;
  private readonly zones: readonly TimeZoneOption[];
  private results: readonly TimeZoneOption[] = [];
  private activeIndex = -1;
  private open = false;
  private committed: string;

  constructor(private readonly options: TimeZonePickerOptions) {
    this.zones = listTimeZones();
    this.referenceMs = options.referenceMs;
    this.committed = options.initialZone;
    this.listboxId = `${options.inputId}-listbox`;

    this.root = document.createElement('div');
    this.root.className = 'tzpicker';

    this.input = document.createElement('input');
    this.input.id = options.inputId;
    this.input.className = 'field__input tzpicker__input';
    this.input.type = 'text';
    this.input.value = options.initialZone;
    this.input.autocomplete = 'off';
    this.input.spellcheck = false;
    this.input.setAttribute('role', 'combobox');
    this.input.setAttribute('aria-expanded', 'false');
    this.input.setAttribute('aria-controls', this.listboxId);
    this.input.setAttribute('aria-autocomplete', 'list');
    this.input.setAttribute('placeholder', 'Search cities and regions');

    this.list = document.createElement('ul');
    this.list.id = this.listboxId;
    this.list.className = 'tzpicker__list';
    this.list.setAttribute('role', 'listbox');
    this.list.setAttribute('aria-label', 'Time zones');
    this.list.hidden = true;

    this.root.append(this.input, this.list);

    this.input.addEventListener('input', this.onInput);
    this.input.addEventListener('focus', this.onFocus);
    this.input.addEventListener('keydown', this.onKeyDown);
    this.list.addEventListener('mousedown', this.onListMouseDown);
    this.list.addEventListener('click', this.onListClick);
    this.root.addEventListener('focusout', this.onFocusOut);
  }

  /** The committed zone id — never a half-typed query. */
  get value(): string {
    return this.committed;
  }

  set value(zone: string) {
    this.committed = zone;
    this.input.value = zone;
  }

  dispose(): void {
    this.input.removeEventListener('input', this.onInput);
    this.input.removeEventListener('focus', this.onFocus);
    this.input.removeEventListener('keydown', this.onKeyDown);
    this.list.removeEventListener('mousedown', this.onListMouseDown);
    this.list.removeEventListener('click', this.onListClick);
    this.root.removeEventListener('focusout', this.onFocusOut);
    this.root.remove();
  }

  // -------------------------------------------------------------------------

  private readonly onInput = (): void => {
    this.refresh(this.input.value);
    this.setOpen(true);
  };

  private readonly onFocus = (): void => {
    // Seeded with the current value, so the list opens on the zone in force;
    // the text is selected, so the first keystroke replaces it and searches.
    this.refresh(this.input.value);
    this.input.select();
    this.setOpen(true);
  };

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        if (!this.open) {
          this.refresh(this.input.value);
          this.setOpen(true);
        }
        this.setActive(this.activeIndex + 1);
        break;
      case 'ArrowUp':
        event.preventDefault();
        if (this.open) this.setActive(this.activeIndex - 1);
        break;
      case 'Enter': {
        const active = this.results[this.activeIndex];
        if (this.open && active) {
          // Only swallow Enter when it is choosing an option; otherwise it must
          // still submit the surrounding form.
          event.preventDefault();
          this.commit(active.id);
        }
        break;
      }
      case 'Escape':
        if (this.open) {
          event.preventDefault();
          this.input.value = this.committed;
          this.setOpen(false);
        }
        break;
      case 'Tab':
        this.setOpen(false);
        break;
      default:
        break;
    }
  };

  /** Keeps focus in the input so the listbox does not close before the click. */
  private readonly onListMouseDown = (event: MouseEvent): void => {
    event.preventDefault();
  };

  private readonly onListClick = (event: MouseEvent): void => {
    const option = (event.target as HTMLElement | null)?.closest('[data-zone]');
    const zone = option?.getAttribute('data-zone');
    if (zone) this.commit(zone);
  };

  private readonly onFocusOut = (event: FocusEvent): void => {
    const next = event.relatedTarget;
    if (next instanceof Node && this.root.contains(next)) return;
    this.setOpen(false);
    this.commitTyped();
  };

  /** Accepts free text if the tz database recognises it, else reverts. */
  private commitTyped(): void {
    const typed = this.input.value.trim();
    if (typed === this.committed) return;

    const known = findTimeZone(this.zones, typed);
    if (known) {
      this.commit(known.id);
      return;
    }
    if (typed !== '' && isValidTimeZone(typed)) {
      this.commit(typed);
      return;
    }
    this.input.value = this.committed;
  }

  private commit(zone: string): void {
    const changed = zone !== this.committed;
    this.committed = zone;
    this.input.value = zone;
    this.setOpen(false);
    if (changed) this.options.onChange?.(zone);
  }

  private refresh(query: string): void {
    this.results = filterTimeZones(this.zones, query, { limit: MAX_RESULTS });
    this.list.replaceChildren(...this.results.map((zone, index) => this.renderOption(zone, index)));
    this.setActive(this.results.findIndex((zone) => zone.id === this.committed));
  }

  private renderOption(zone: TimeZoneOption, index: number): HTMLLIElement {
    const item = document.createElement('li');
    item.className = 'tzpicker__option';
    item.id = `${this.listboxId}-option-${String(index)}`;
    item.setAttribute('role', 'option');
    item.setAttribute('aria-selected', String(zone.id === this.committed));
    item.dataset['zone'] = zone.id;

    const name = document.createElement('span');
    name.className = 'tzpicker__option-name';
    name.textContent = zone.city;

    const region = document.createElement('span');
    region.className = 'tzpicker__option-region';
    region.textContent = zone.region;

    const offset = document.createElement('span');
    offset.className = 'tzpicker__option-offset';
    offset.textContent = zoneOffset(zone.id, this.referenceMs) ?? '';

    item.append(name, region, offset);
    return item;
  }

  private setActive(index: number): void {
    if (this.results.length === 0) {
      this.activeIndex = -1;
      this.input.removeAttribute('aria-activedescendant');
      return;
    }

    const clamped = Math.min(Math.max(index, 0), this.results.length - 1);
    this.activeIndex = clamped;

    const children = [...this.list.children];
    children.forEach((child, i) => {
      child.classList.toggle('tzpicker__option--active', i === clamped);
    });

    const active = children[clamped];
    if (active) {
      this.input.setAttribute('aria-activedescendant', active.id);
      active.scrollIntoView({ block: 'nearest' });
    }
  }

  private setOpen(open: boolean): void {
    if (this.open === open) return;
    this.open = open;
    this.list.hidden = !open;
    this.input.setAttribute('aria-expanded', String(open));
    if (!open) this.input.removeAttribute('aria-activedescendant');
  }
}
