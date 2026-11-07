const test = require("node:test");
const assert = require("node:assert/strict");
const { clean, format, parse } = require("../number-input.js");

test("format groups thousands with commas", () => {
  assert.equal(format("1000000"), "1,000,000");
  assert.equal(format("100000"), "100,000");
  assert.equal(format("950"), "950");
  assert.equal(format(2500000), "2,500,000");
  assert.equal(format(""), "");
});

test("format keeps decimals and strips leading zeros", () => {
  assert.equal(format("12345.5"), "12,345.5");
  assert.equal(format("0007"), "7");
  assert.equal(format("0"), "0");
  assert.equal(format("-32.08"), "-32.08");
});

test("clean and parse ignore commas, spaces and currency signs", () => {
  assert.equal(clean("₪ 1,250,000"), "1250000");
  assert.equal(parse("1,250,000"), 1250000);
  assert.equal(parse("3.5"), 3.5);
  assert.ok(Number.isNaN(parse("")));
  assert.equal(clean("1.2.3"), "1.23");
});
