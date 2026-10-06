#!/usr/bin/env node
"use strict";

const fs = require("fs");
if (process.argv.length !== 4) {
  process.stderr.write("Usage: node bin2hex.js firmware.bin firmware.hex\n");
  process.exit(2);
}

const data = fs.readFileSync(process.argv[2]);
const startAddress = 0x08000000;
const lines = [];

function record(address, type, bytes) {
  const count = bytes.length;
  let sum = count + ((address >> 8) & 0xff) + (address & 0xff) + type;
  let text = `:${count.toString(16).padStart(2, "0")}${address.toString(16).padStart(4, "0")}${type.toString(16).padStart(2, "0")}`;
  for (const value of bytes) {
    sum = (sum + value) & 0xff;
    text += value.toString(16).padStart(2, "0");
  }
  text += ((-sum) & 0xff).toString(16).padStart(2, "0");
  lines.push(text.toUpperCase());
}

let currentUpper = -1;
for (let offset = 0; offset < data.length; offset += 16) {
  const absolute = startAddress + offset;
  const upper = absolute >>> 16;
  if (upper !== currentUpper) {
    record(0, 4, [(upper >> 8) & 0xff, upper & 0xff]);
    currentUpper = upper;
  }
  record(absolute & 0xffff, 0, [...data.subarray(offset, offset + 16)]);
}
record(0, 1, []);
fs.writeFileSync(process.argv[3], lines.join("\r\n") + "\r\n");
