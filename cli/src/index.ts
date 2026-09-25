#!/usr/bin/env node
import { main } from './main';

void main().then((code) => {
  process.exitCode = code;
});
