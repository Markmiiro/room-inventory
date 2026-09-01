/** Design tokens from TOKENS.md.
 *
 * Eight colours do all the work. The Material Design scaffolding in the
 * mockups' own config is unused and deliberately not carried over.
 */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        primary: "#154212",
        "primary-container": "#2D5A27",
        background: "#F4F7F2",
        card: "#FFFFFF",
        text: "#191C1A",
        "text-muted": "#42493E",
        border: "#D1D1D1",
        action: "#FFD700",
        "action-text": "#4A4A4A",
        alert: "#BA1A1A",
        "alert-bg": "#FFDAD6",
        "alert-text": "#93000A",
        success: "#B9EEAB",
        "success-text": "#3F6D38",
      },
      fontFamily: {
        sans: ["Inter", "system-ui", "sans-serif"],
        mono: ["JetBrains Mono", "ui-monospace", "monospace"],
      },
      fontSize: {
        "headline-lg": ["32px", { lineHeight: "40px", fontWeight: "700", letterSpacing: "-0.02em" }],
        "headline-lg-mobile": ["26px", { lineHeight: "32px", fontWeight: "700", letterSpacing: "-0.02em" }],
        "headline-md": ["24px", { lineHeight: "32px", fontWeight: "600", letterSpacing: "-0.02em" }],
        "headline-sm": ["20px", { lineHeight: "28px", fontWeight: "600", letterSpacing: "-0.02em" }],
        "body-lg": ["18px", { lineHeight: "26px", fontWeight: "400" }],
        "body-md": ["16px", { lineHeight: "24px", fontWeight: "400" }],
        "data-value": ["16px", { lineHeight: "24px", fontWeight: "500", letterSpacing: "0.02em" }],
        "data-label": ["12px", { lineHeight: "16px", fontWeight: "500", letterSpacing: "0.05em" }],
      },
      borderRadius: {
        DEFAULT: "8px",
        lg: "8px",
        xl: "12px",
        full: "9999px",
      },
      boxShadow: {
        // TOKENS.md: one shadow only. No other elevation.
        card: "0 4px 12px rgba(0,0,0,0.08)",
        "card-up": "0 -4px 12px rgba(0,0,0,0.08)",
      },
      spacing: {
        touch: "48px",
        "touch-desktop": "40px",
        input: "56px",
        "input-desktop": "44px",
        row: "56px",
      },
    },
  },
  plugins: [],
};
