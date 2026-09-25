#!/usr/bin/env node
import { main } from '../compatibility/main';

void main().then((code) => {
  process.exitCode = code;
});
