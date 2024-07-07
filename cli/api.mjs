#!/usr/bin/env zx
import path from 'path';

const dir_root = process.env.QL_DIR;
const file_auth_token = path.join(dir_root, 'static/auth.json');
const token_file = path.join(dir_root, 'static/build/token.js');

let token;

const createToken = async () => {
  let tokenCommand = `tsx ${dir_root}/back/token.ts`;
  if (await fs.exists(token_file)) {
    tokenCommand = `node ${token_file}`;
  }
  token = (await $([tokenCommand])).stdout.trim();
};

const getToken = async () => {
  if (fs.existsSync(file_auth_token)) {
    const authTokenData = JSON.parse(fs.readFileSync(file_auth_token, 'utf8'));
    token = authTokenData.value;
    const expiration = authTokenData.expiration;
    const currentTimeStamp = Math.floor(Date.now() / 1000);
    if (currentTimeStamp >= expiration) {
      await createToken();
    }
  } else {
    await createToken();
  }
};

export const addCronApi = async (schedule, command, name, subId = null) => {
  const currentTimeStamp = Math.floor(Date.now() / 1000);
  const data = {
    name,
    command,
    schedule,
    sub_id: subId,
  };

  try {
    const response = await fetch(
      `http://0.0.0.0:5600/open/crons?t=${currentTimeStamp}`,
      {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${token}`,
          'User-Agent': 'Mozilla/5.0',
          'Content-Type': 'application/json;charset=UTF-8',
        },
        body: JSON.stringify(data),
      },
    );

    const responseData = await response.json();
    const { code, message } = responseData;
    if (code === 200) {
      console.log(`${name} -> 添加成功`);
    } else {
      console.log(`${name} -> 添加失败(${message})`);
    }
  } catch (error) {
    console.error(`${name} -> 添加失败(${error.message})`);
  }
};

export const updateCronApi = async (schedule, command, name, id) => {
  const currentTimeStamp = Math.floor(Date.now() / 1000);
  const data = {
    name,
    command,
    schedule,
    id,
  };

  try {
    const response = await fetch(
      `http://0.0.0.0:5600/open/crons?t=${currentTimeStamp}`,
      {
        method: 'PUT',
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${token}`,
          'User-Agent': 'Mozilla/5.0',
          'Content-Type': 'application/json;charset=UTF-8',
        },
        body: JSON.stringify(data),
      },
    );

    const responseData = await response.json();
    const { code, message } = responseData;
    if (code === 200) {
      console.log(`${name} -> 更新成功`);
    } else {
      console.log(`${name} -> 更新失败(${message})`);
    }
  } catch (error) {
    console.error(`${name} -> 更新失败(${error.message})`);
  }
};

export const updateCronCommandApi = async (command, id) => {
  const currentTimeStamp = Math.floor(Date.now() / 1000);
  const data = {
    command,
    id,
  };

  try {
    const response = await fetch(
      `http://0.0.0.0:5600/open/crons?t=${currentTimeStamp}`,
      {
        method: 'PUT',
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${token}`,
          'User-Agent': 'Mozilla/5.0',
          'Content-Type': 'application/json;charset=UTF-8',
        },
        body: JSON.stringify(data),
      },
    );

    const responseData = await response.json();
    const { code, message } = responseData;
    if (code === 200) {
      console.log(`${command} -> 更新成功`);
    } else {
      console.log(`${command} -> 更新失败(${message})`);
    }
  } catch (error) {
    console.error(`${command} -> 更新失败(${error.message})`);
  }
};

export const delCronApi = async (ids) => {
  const currentTimeStamp = Math.floor(Date.now() / 1000);

  try {
    const response = await fetch(
      `http://0.0.0.0:5600/open/crons?t=${currentTimeStamp}`,
      {
        method: 'DELETE',
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${token}`,
          'User-Agent': 'Mozilla/5.0',
          'Content-Type': 'application/json;charset=UTF-8',
        },
        body: JSON.stringify(ids),
      },
    );

    const responseData = await response.json();
    const { code, message } = responseData;
    if (code === 200) {
      console.log('成功');
    } else {
      console.log(`失败(${message})`);
    }
  } catch (error) {
    console.error(`删除失败(${error.message})`);
  }
};

export const updateCron = async (
  ids,
  status,
  pid,
  logPath,
  lastExecutingTime = 0,
  runningTime = 0,
) => {
  const currentTimeStamp = Math.floor(Date.now() / 1000);
  const data = {
    ids,
    status,
    pid,
    log_path: logPath,
    last_execution_time: lastExecutingTime,
    last_running_time: runningTime,
  };

  try {
    const response = await fetch(
      `http://0.0.0.0:5600/open/crons/status?t=${currentTimeStamp}`,
      {
        method: 'PUT',
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${token}`,
          'User-Agent': 'Mozilla/5.0',
          'Content-Type': 'application/json;charset=UTF-8',
        },
        body: JSON.stringify(data),
      },
    );

    const responseData = await response.json();
    const { code, message } = responseData;
    if (code !== 200) {
      console.log(`更新任务状态失败(${message})`);
    }
  } catch (error) {
    console.error(`更新任务状态失败(${error.message})`);
  }
};

export const notifyApi = async (title, content) => {
  const currentTimeStamp = Math.floor(Date.now() / 1000);
  const data = {
    title,
    content,
  };

  try {
    const response = await fetch(
      `http://0.0.0.0:5600/open/system/notify?t=${currentTimeStamp}`,
      {
        method: 'PUT',
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${token}`,
          'User-Agent': 'Mozilla/5.0',
          'Content-Type': 'application/json;charset=UTF-8',
        },
        body: JSON.stringify(data),
      },
    );

    const responseData = await response.json();
    const { code, message } = responseData;
    if (code === 200) {
      console.log('通知发送成功🎉');
    } else {
      console.log(`通知失败(${message})`);
    }
  } catch (error) {
    console.error(`通知失败(${error.message})`);
  }
};

export const findCronApi = async (params) => {
  const currentTimeStamp = Math.floor(Date.now() / 1000);

  try {
    const response = await fetch(
      `http://0.0.0.0:5600/open/crons/detail?${params}&t=${currentTimeStamp}`,
      {
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${token}`,
          'User-Agent': 'Mozilla/5.0',
          'Content-Type': 'application/json;charset=UTF-8',
        },
      },
    );

    const responseData = await response.json();
    const { data } = responseData;
    if (data === 'null') {
      console.log('');
    } else {
      const { name } = data;
      console.log(name);
    }
  } catch (error) {
    console.error(`查找失败(${error.message})`);
  }
};

await getToken();
