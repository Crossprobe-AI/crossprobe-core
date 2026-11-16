# Compatibility checks

Rule-based checks across connected parts. No model is involved; the Review tab
shows them live under **Compatibility**.

A part's supply rail is the voltage its power-input pins' net names promise
(`+3V3`, `+5V`, `VBUS`). A part on several rails, or on a rail the name doesn't
give, is skipped rather than guessed.

- **Rail crossings.** A signal driven from a higher rail into a lower-rail
  input (check the input's absolute maximum / 5 V tolerance), or from a rail
  below 0.7 x VDD of the receiver (check VIH). I2C nets are handled below.
- **I2C pull-ups.** SDA/SCL nets with no resistor to a named rail, a parallel
  pull-up under 1 kΩ, or a pull-up to a rail above a device's own supply.

- **Pinned datasheet ratings.** Voltage rows you pinned to a part (under an
  *Absolute maximum ratings* or *Recommended operating conditions* heading) are
  read as printed. A rail crossing into a pin with a pinned abs-max becomes an
  error when it exceeds it (an info note when within), and a part's supply rail
  is checked against its pinned abs-max and operating range. Each such finding
  quotes the row and page it rests on. Rows under other headings are ignored.

Findings without a pinned row are conditions to verify in the datasheet, not
verdicts. Code: `apps/web/src/compat/compat.ts`; tests:
`apps/web/test/compat.test.ts`.
