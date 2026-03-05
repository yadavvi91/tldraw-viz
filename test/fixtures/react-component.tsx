import { COBALT } from '../utils/colors';

interface ControlProps {
  value: number;
  label: string;
  onValueChange: (val: number) => void;
  onReset: () => void;
  isActive: boolean;
}

function formatDisplay(n: number): string {
  return `${n.toFixed(2)}`;
}

function clampValue(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

export function Controls({
  value,
  label,
  onValueChange,
  onReset,
  isActive,
}: ControlProps) {
  const displayValue = isActive
    ? formatDisplay(value)
    : 'inactive';

  const clamped = clampValue(value, 0, 100);

  return (
    <div>
      <label>{label}</label>
      <input
        type="range"
        value={clamped}
        onChange={(e) => onValueChange(parseFloat(e.target.value))}
      />
      <span>{displayValue}</span>
      <button onClick={onReset}>Reset</button>
      {isActive && <div>Active indicator</div>}
    </div>
  );
}
