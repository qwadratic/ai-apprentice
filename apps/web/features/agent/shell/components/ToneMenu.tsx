import { useEffect, useRef } from 'react';
import { useShell, useShellState } from '../hooks.ts';
import { PERSONAS, PERSONA_INFO } from '../state/types.ts';
import type { Persona } from '../state/types.ts';

/** Clipa's tone (the policy persona), tucked into a small menu so the header keeps to the logo, the rail and two buttons. */
export function ToneMenu() {
  const { controller } = useShell();
  const persona = useShellState((s) => s.persona);
  const ref = useRef<HTMLDetailsElement>(null);

  // Close on a click elsewhere or on Escape, like a menu.
  useEffect(() => {
    const onPointer = (e: PointerEvent): void => {
      const el = ref.current;
      if (el?.open && e.target instanceof Node && !el.contains(e.target)) el.open = false;
    };
    const onKey = (e: globalThis.KeyboardEvent): void => {
      const el = ref.current;
      if (e.key !== 'Escape' || !el?.open) return;
      el.open = false;
      el.querySelector('summary')?.focus();
    };
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, []);

  return (
    <details className="as-menu" ref={ref}>
      <summary className="as-btn as-menu__button" title={`Clipa's tone: ${PERSONA_INFO[persona].label}`}>
        Tone<span className="as-sr">: {PERSONA_INFO[persona].label}</span>
      </summary>
      <div className="as-menu__panel">
        <label className="as-field">
          <span className="as-field__label">Clipa's tone, read when a session starts</span>
          <select
            className="as-select"
            value={persona}
            title={PERSONA_INFO[persona].hint}
            onChange={(e) => controller.setPersona(e.target.value as Persona)}
          >
            {PERSONAS.map((p) => <option key={p} value={p}>{PERSONA_INFO[p].label}: {PERSONA_INFO[p].hint}</option>)}
          </select>
        </label>
      </div>
    </details>
  );
}
