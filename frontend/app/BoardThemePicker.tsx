"use client";

import React from "react";
import { BOARD_THEMES, THEME_ORDER, type BoardThemeKey } from "./boardThemes";

interface Props {
  value: BoardThemeKey;
  onChange: (key: BoardThemeKey) => void;
}

export function BoardThemePicker({ value, onChange }: Props) {
  const activeLabel = BOARD_THEMES[value]?.label ?? "";
  const [name, era] = activeLabel.includes(" — ")
    ? activeLabel.split(" — ", 2)
    : [activeLabel, ""];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {/* Active board label */}
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, minHeight: 18 }}>
        <span style={{
          fontFamily: "var(--cg-font-sans)",
          fontSize: 13,
          fontWeight: 600,
          color: "var(--cg-fg-1)",
        }}>{name}</span>
        {era && (
          <span style={{
            fontFamily: "var(--cg-font-mono)",
            fontSize: 11,
            color: "var(--cg-fg-3)",
          }}>{era}</span>
        )}
      </div>

      {/* Swatch grid */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
        {THEME_ORDER.map((key, idx) => {
          const t = BOARD_THEMES[key];
          const active = key === value;
          return (
            <React.Fragment key={key}>
              {idx === 13 && (
                <span style={{ width: "100%", height: 1, background: "rgba(255,255,255,0.12)", flexShrink: 0, margin: "2px 0" }} />
              )}
            <button
              title={t.label}
              onClick={() => onChange(key)}
              style={{
                width: 28,
                height: 28,
                borderRadius: 6,
                border: active
                  ? "2px solid var(--cg-brass)"
                  : "1.5px solid rgba(255,255,255,0.12)",
                padding: 0,
                cursor: "pointer",
                overflow: "hidden",
                background: "none",
                boxShadow: active
                  ? "0 0 0 1px var(--cg-brass-lo)"
                  : "none",
                flexShrink: 0,
                position: "relative",
              }}
              aria-label={t.label}
              aria-pressed={active}
            >
              {t.backgroundImageUrl ? (
                /* Image thumbnail for image-based themes.
                   When backgroundImageCrop is set, use CSS background-size
                   + background-position to show only the relevant crop. */
                <span style={(() => {
                  const crop = t.backgroundImageCrop;
                  if (crop) {
                    // Scale so that the crop section fills the 28×28 thumbnail.
                    const sx = 28 / crop.srcW;
                    const sy = 28 / crop.srcH;
                    return {
                      position: "absolute" as const, top: 0, left: 0,
                      width: "100%", height: "100%",
                      backgroundImage: `url(${t.backgroundImageUrl})`,
                      backgroundSize: `${crop.totalSrcW * sx}px ${crop.totalSrcH * sy}px`,
                      backgroundPosition: `${-crop.srcX * sx}px ${-crop.srcY * sy}px`,
                      backgroundRepeat: "no-repeat",
                    };
                  }
                  return {
                    position: "absolute" as const, top: 0, left: 0,
                    width: "100%", height: "100%",
                    backgroundImage: `url(${t.backgroundImageUrl})`,
                    backgroundSize: "cover",
                    backgroundPosition: "center",
                  };
                })()} />
              ) : (
                <>
                  {/* Left half: felt color */}
                  <span style={{
                    position: "absolute", top: 0, left: 0,
                    width: "50%", height: "100%",
                    background: t.felt,
                  }} />
                  {/* Right half: frame color */}
                  <span style={{
                    position: "absolute", top: 0, right: 0,
                    width: "50%", height: "100%",
                    background: `linear-gradient(180deg, ${t.frameStart}, ${t.frameEnd})`,
                  }} />
                  {/* Point color stripe */}
                  <span style={{
                    position: "absolute",
                    top: "25%", left: "20%",
                    width: "30%", height: "50%",
                    background: t.pointDark,
                    opacity: 0.85,
                  }} />
                </>
              )}
            </button>
            </React.Fragment>
          );
        })}
      </div>
    </div>
  );
}
