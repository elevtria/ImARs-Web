import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import postcss from "postcss";

const theme = postcss.parse(readFileSync(new URL("../css/theme.css", import.meta.url), "utf8"));
const portal = postcss.parse(readFileSync(new URL("../css/portal-design.css", import.meta.url), "utf8"));
const palette = {};
for (const css of [theme, portal]) css.walkRules(rule => {
  if (!rule.selector.startsWith(':root[data-theme="dark"]')) return;
  rule.walkDecls(declaration => {
    if (declaration.prop.startsWith("--") && /^#[a-f\d]{6}$/i.test(declaration.value)) palette[declaration.prop] = declaration.value;
  });
});

function luminance(hex) {
  const channels = hex.slice(1).match(/../g).map(value => parseInt(value, 16) / 255)
    .map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
  return channels[0] * .2126 + channels[1] * .7152 + channels[2] * .0722;
}
function contrast(foreground, background) {
  const values = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (values[0] + .05) / (values[1] + .05);
}
const surfaces = [palette["--surface"], palette["--scene-surface"], palette["--scene-soft"],
  palette["--theme-info-bg"], palette["--theme-input-bg"], "#28496d", "#1f4a70", "#1d4a78"];

test("dark text, labels, links and status messages meet 4.5:1 on cards, inputs and hover surfaces", () => {
  for (const token of ["--ink", "--muted", "--admin-ink", "--admin-muted", "--scene-ink", "--scene-muted",
    "--theme-text", "--theme-muted", "--theme-link", "--theme-success", "--theme-warning", "--theme-danger", "--steel"]) {
    assert.ok(palette[token], token);
    for (const background of surfaces) {
      const ratio = contrast(palette[token], background);
      assert.ok(ratio >= 4.5, `${token} on ${background}: ${ratio.toFixed(2)}:1`);
    }
  }
});

test("dark success, warning and error states retain readable text on their own tinted surfaces", () => {
  for (const state of ["success", "warning", "danger"]) {
    assert.ok(contrast(palette[`--theme-${state}`], palette[`--theme-${state}-bg`]) >= 4.5, state);
    assert.ok(contrast(palette["--theme-text"], palette[`--theme-${state}-bg`]) >= 4.5, state + " input text");
  }
});

test("primary buttons remain readable and form outlines remain visible across dark surfaces", () => {
  const blue = palette["--theme-primary"];
  assert.ok(contrast("#ffffff", blue) >= 4.5);
  portal.walkRules(rule => {
    if (rule.selector.startsWith(':root[data-theme="dark"]') && rule.selector.includes(".scan-btn")) {
      rule.walkDecls("background", declaration => {
        assert.ok(contrast("#ffffff", declaration.value) >= 4.5, rule.selector);
      });
    }
  });
  for (const background of surfaces) assert.ok(contrast(palette["--theme-control-border"], background) >= 3, background);
});
