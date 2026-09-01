# TOKENS.md — Design tokens

Visual constants for Room Inventory. These are extracted from the Stitch mockups
in `reference-only/`. Where this file and the mockups disagree, **this file wins**.

---

## Colours

Eight colours do all the work. Everything else in the mockups' Tailwind config is
unused Material Design scaffolding — ignore it.

| Token | Hex | Used for |
|---|---|---|
| `primary` | `#154212` | Top bars, headings, emphasis text |
| `primary-container` | `#2D5A27` | Secondary buttons, selected states, progress fills |
| `background` | `#F4F7F2` | Page canvas. A tinted off-white chosen to cut glare in a livestock building |
| `card` | `#FFFFFF` | Cards, list rows, inputs |
| `text` | `#191C1A` | Body text |
| `text-muted` | `#42493E` | Secondary text, labels, icons |
| `border` | `#D1D1D1` | Input outlines, dividers |
| `action` | `#FFD700` | **The single primary action button on a screen. Nothing else.** Text on it is `#4A4A4A` |
| `alert` | `#BA1A1A` | Problems only: over capacity, overdue, deaths, isolation |
| `alert-bg` | `#FFDAD6` | Background of alert banners. Text on it is `#93000A` |
| `success` | `#B9EEAB` | Background of positive chips. Text on it is `#3F6D38` |

Note: the mockups use `#f7faf5` as background in some files. Use `#F4F7F2`.

### Colour rules

- `action` yellow appears **once per screen**, on the primary button. Never on
  chips, never on secondary buttons, never as decoration.
- `alert` red is **only** for problems. Never a button colour, never navigation.
- **Colour never carries meaning alone.** Every status shows a word, and an icon
  where there's room. A bare coloured dot is not an acceptable status indicator.

---

## Typography

Two families. Load Inter and JetBrains Mono locally — the app must render fully
offline, so no CDN font links.

**Inter** — all prose.

| Style | Size / line height | Weight |
|---|---|---|
| `headline-lg` | 32 / 40 | 700 |
| `headline-lg-mobile` | 26 / 32 | 700 |
| `headline-md` | 24 / 32 | 600 |
| `headline-sm` | 20 / 28 | 600 |
| `body-lg` | 18 / 26 | 400 |
| `body-md` | 16 / 24 | 400 |

Headlines carry `-0.02em` letter spacing. **Body text is never below 16px.**

**JetBrains Mono** — every identifier and figure. Room codes, tag numbers, head
counts, dates, money, and small uppercase field labels. This is what makes data
read as data rather than prose.

| Style | Size / line height | Weight | Letter spacing |
|---|---|---|---|
| `data-value` | 16 / 24 | 500 | 0.02em |
| `data-label` | 12 / 16 | 500 | 0.05em, uppercase |

---

## Shape and space

- **Radius** — 8px on buttons and standard cards, 12px on large cards, fully
  rounded (9999px) on chips and pills.
- **Spacing grid** — 8px base unit. Page margins 16px. Gutter between cards 16px.
- **Shadow** — one only: `0 4px 12px rgba(0,0,0,0.08)`. No other elevation.

---

## Interaction sizing

Sized for a phone used one-handed in a livestock building.

| Element | Mobile | Desktop |
|---|---|---|
| Minimum touch target | 48px | 40px |
| Input field height | 56px | 44px |
| Checkbox / radio | 24px | 20px |
| List row height | 56px minimum | 48px minimum |
| Body text | 16px minimum | 16px minimum |

---

## Species icons

**Do not use Material Symbols for species.** The icon set has no livestock, and
every attempt in the mockups produced something wrong — a tractor for cattle, a
piggy bank then a rat for pigs, a bug for poultry, a bee for sheep.

Use five small custom SVG icons: cattle, goats, sheep, pigs, poultry. One icon
per species, used identically everywhere it appears. Until they exist, use the
species name as text rather than a misleading icon.

Material Symbols is fine for everything else — navigation, actions, status.
