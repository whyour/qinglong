#!/usr/bin/env zx

import 'zx/globals';
let initialVars = [];

export const storeEnvVars = async () => {
  const stdout = (await $`env`).lines();
  initialVars = stdout.map((line) => line.split('=')[0]);
};

export const restoreEnvVars = async () => {
  const stdout = (await $`env`).lines();
  const currentVars = stdout.map((line) => line.split('=')[0]);

  for (const key of currentVars) {
    if (!initialVars.includes(key)) {
      await $`unset ${key}`;
    }
  }
};

await storeEnvVars();
