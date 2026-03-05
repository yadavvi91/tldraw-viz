import { COBALT } from '../utils/colors';
import type { SunPosition, AnimationMode, AnimationSpeed } from '../types';

interface SunControlsProps {
  date: Date;
  timeOfDay: number;
  sunPosition: SunPosition;
  sunrise: Date;
  sunset: Date;
  onDateChange: (date: Date) => void;
  onTimeChange: (hour: number) => void;
  isPlaying: boolean;
  onTogglePlay: () => void;
  animationMode: AnimationMode;
  onAnimationModeChange: (mode: AnimationMode) => void;
  animationSpeed: AnimationSpeed;
  onAnimationSpeedChange: (speed: AnimationSpeed) => void;
}

function formatTime(date: Date): string {
  return date.toLocaleTimeString('en-IN', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  });
}

function formatDeg(radians: number): string {
  return `${((radians * 180) / Math.PI).toFixed(1)}°`;
}

const SPEEDS: AnimationSpeed[] = [1, 2, 5, 10];

export function SunControls({
  date,
  timeOfDay,
  sunPosition,
  sunrise,
  sunset,
  onDateChange,
  onTimeChange,
  isPlaying,
  onTogglePlay,
  animationMode,
  onAnimationModeChange,
  animationSpeed,
  onAnimationSpeedChange,
}: SunControlsProps) {
  const dateStr = date.toISOString().split('T')[0];

  // Progress: daily = 0-1 across 5-19h, yearly/monthly = 0-1 across Jan 1 - Dec 31
  const progress =
    animationMode === 'daily'
      ? (timeOfDay - 5) / 14
      : (dayOfYear(date) - 1) / 364;

  const MONTH_NAMES = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

  return (
    <div className="space-y-4">
      <div>
        <label
          className="block text-xs font-mono lowercase tracking-wider mb-1"
          style={{ color: COBALT[300] }}
        >
          date
        </label>
        <input
          type="date"
          value={dateStr}
          onChange={(e) => {
            const d = new Date(e.target.value);
            d.setHours(timeOfDay, 0, 0, 0);
            onDateChange(d);
          }}
          className="w-full px-2 py-1.5 text-sm font-mono rounded border"
          style={{
            background: 'transparent',
            borderColor: COBALT[600] + '40',
            color: COBALT[50],
          }}
        />
      </div>

      <div>
        <label
          className="block text-xs font-mono lowercase tracking-wider mb-1"
          style={{ color: COBALT[300] }}
        >
          time of day — {timeOfDay.toFixed(1)}h
        </label>
        <input
          type="range"
          min="5"
          max="19"
          step="0.25"
          value={timeOfDay}
          onChange={(e) => onTimeChange(parseFloat(e.target.value))}
          className="w-full"
          style={{ accentColor: COBALT[600] }}
        />
      </div>

      {/* Animation controls */}
      <div className="space-y-2">
        <label
          className="block text-xs font-mono lowercase tracking-wider"
          style={{ color: COBALT[300] }}
        >
          timelapse
        </label>

        {/* Mode selector */}
        <div className="flex gap-1.5">
          {(['daily', 'yearly', 'monthly'] as AnimationMode[]).map((mode) => (
            <button
              key={mode}
              onClick={() => onAnimationModeChange(mode)}
              className="flex-1 px-2 py-1 text-[10px] font-mono lowercase rounded border text-center"
              style={{
                borderColor:
                  animationMode === mode ? COBALT[600] : COBALT[600] + '40',
                color: animationMode === mode ? COBALT[50] : COBALT[300],
                background:
                  animationMode === mode ? COBALT[600] + '40' : 'transparent',
              }}
            >
              {mode}
            </button>
          ))}
        </div>

        {/* Speed + play row */}
        <div className="flex items-center gap-1.5">
          {SPEEDS.map((s) => (
            <button
              key={s}
              onClick={() => onAnimationSpeedChange(s)}
              className="px-1.5 py-0.5 text-[10px] font-mono rounded border"
              style={{
                borderColor:
                  animationSpeed === s ? COBALT[600] : COBALT[600] + '40',
                color: animationSpeed === s ? COBALT[50] : COBALT[300],
                background:
                  animationSpeed === s ? COBALT[600] + '40' : 'transparent',
              }}
            >
              {s}x
            </button>
          ))}
          <button
            onClick={onTogglePlay}
            className="ml-auto px-2 py-0.5 text-[10px] font-mono rounded border"
            style={{
              borderColor: COBALT[600],
              color: isPlaying ? COBALT.sidebar : COBALT[50],
              background: isPlaying ? COBALT[600] : 'transparent',
            }}
          >
            {isPlaying ? 'pause' : 'play'}
          </button>
        </div>

        {/* Month label for monthly mode */}
        {animationMode === 'monthly' && (
          <div
            className="text-[10px] font-mono lowercase text-center"
            style={{ color: COBALT[50] }}
          >
            {MONTH_NAMES[date.getMonth()]} {date.getDate()} — {timeOfDay.toFixed(1)}h fixed
          </div>
        )}

        {/* Progress bar */}
        <div
          className="w-full h-1 rounded-full overflow-hidden"
          style={{ background: COBALT[600] + '30' }}
        >
          <div
            className="h-full rounded-full transition-all duration-200"
            style={{
              width: `${Math.max(0, Math.min(100, progress * 100))}%`,
              background: COBALT[600],
            }}
          />
        </div>
      </div>

      {/* Sun info */}
      <div
        className="grid grid-cols-2 gap-2 text-xs font-mono lowercase"
        style={{ color: COBALT[300] }}
      >
        <div>
          <span style={{ color: COBALT[50] }}>altitude </span>
          {formatDeg(sunPosition.altitude)}
        </div>
        <div>
          <span style={{ color: COBALT[50] }}>azimuth </span>
          {formatDeg(sunPosition.azimuth)}
        </div>
        <div>
          <span style={{ color: COBALT[50] }}>sunrise </span>
          {formatTime(sunrise)}
        </div>
        <div>
          <span style={{ color: COBALT[50] }}>sunset </span>
          {formatTime(sunset)}
        </div>
      </div>
    </div>
  );
}

function dayOfYear(d: Date): number {
  const start = new Date(d.getFullYear(), 0, 0);
  const diff = d.getTime() - start.getTime();
  return Math.floor(diff / 86400000);
}
