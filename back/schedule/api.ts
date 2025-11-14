import 'reflect-metadata';
import { Container } from 'typedi';
import EnvService from '../services/env';
import { sendUnaryData, ServerUnaryCall } from '@grpc/grpc-js';
import {
  CreateEnvRequest,
  CronItem,
  DeleteEnvsRequest,
  DisableEnvsRequest,
  EnableEnvsRequest,
  EnvItem,
  EnvResponse,
  EnvsResponse,
  GetEnvByIdRequest,
  GetEnvsRequest,
  MoveEnvRequest,
  Response,
  SystemNotifyRequest,
  UpdateEnvNamesRequest,
  UpdateEnvRequest,
} from '../protos/api';
import LoggerInstance from '../loaders/logger';
import pick from 'lodash/pick';
import SystemService from '../services/system';
import CronService from '../services/cron';
import {
  CronDetailRequest,
  CronDetailResponse,
  CreateCronRequest,
  UpdateCronRequest,
  DeleteCronsRequest,
  CronResponse,
  GetCronsRequest,
  CronsResponse,
  GetCronByIdRequest,
  EnableCronsRequest,
  DisableCronsRequest,
  RunCronsRequest,
} from '../protos/api';
import { NotificationInfo } from '../data/notify';

Container.set('logger', LoggerInstance);

export const getEnvs = async (
  call: ServerUnaryCall<GetEnvsRequest, EnvsResponse>,
  callback: sendUnaryData<EnvsResponse>,
) => {
  try {
    const envService = Container.get(EnvService);
    const data = await envService.envs(call.request.searchValue);
    callback(null, {
      code: 200,
      data: data.map((x) => ({ ...x, remarks: x.remarks || '' })),
    });
  } catch (e: any) {
    callback(null, {
      code: 500,
      data: [],
      message: e.message,
    });
  }
};

export const createEnv = async (
  call: ServerUnaryCall<CreateEnvRequest, EnvsResponse>,
  callback: sendUnaryData<EnvsResponse>,
) => {
  try {
    const envService = Container.get(EnvService);
    const data = await envService.create(call.request.envs);
    callback(null, { code: 200, data });
  } catch (e: any) {
    callback(e);
  }
};

export const updateEnv = async (
  call: ServerUnaryCall<UpdateEnvRequest, EnvResponse>,
  callback: sendUnaryData<EnvResponse>,
) => {
  try {
    if (!call.request.env?.id) {
      return callback(null, {
        code: 400,
        data: undefined,
        message: 'id parameter is required',
      });
    }

    const envService = Container.get(EnvService);
    const data = await envService.update(
      pick(call.request.env, ['id', 'name', 'value', 'remarks']) as EnvItem,
    );
    callback(null, { code: 200, data });
  } catch (e: any) {
    callback(e);
  }
};

export const deleteEnvs = async (
  call: ServerUnaryCall<DeleteEnvsRequest, Response>,
  callback: sendUnaryData<Response>,
) => {
  try {
    if (!call.request.ids || call.request.ids.length === 0) {
      return callback(null, {
        code: 400,
        message: 'ids parameter is required',
      });
    }

    const envService = Container.get(EnvService);
    await envService.remove(call.request.ids);
    callback(null, { code: 200 });
  } catch (e: any) {
    callback(e);
  }
};

export const moveEnv = async (
  call: ServerUnaryCall<MoveEnvRequest, EnvResponse>,
  callback: sendUnaryData<EnvResponse>,
) => {
  try {
    if (!call.request.id) {
      return callback(null, {
        code: 400,
        data: undefined,
        message: 'id parameter is required',
      });
    }

    const envService = Container.get(EnvService);
    const data = await envService.move(call.request.id, {
      fromIndex: call.request.fromIndex,
      toIndex: call.request.toIndex,
    });
    callback(null, { code: 200, data });
  } catch (e: any) {
    callback(e);
  }
};

export const disableEnvs = async (
  call: ServerUnaryCall<DisableEnvsRequest, Response>,
  callback: sendUnaryData<Response>,
) => {
  try {
    if (!call.request.ids || call.request.ids.length === 0) {
      return callback(null, {
        code: 400,
        message: 'ids parameter is required',
      });
    }

    const envService = Container.get(EnvService);
    await envService.disabled(call.request.ids);
    callback(null, { code: 200 });
  } catch (e: any) {
    callback(e);
  }
};

export const enableEnvs = async (
  call: ServerUnaryCall<EnableEnvsRequest, Response>,
  callback: sendUnaryData<Response>,
) => {
  try {
    if (!call.request.ids || call.request.ids.length === 0) {
      return callback(null, {
        code: 400,
        message: 'ids parameter is required',
      });
    }

    const envService = Container.get(EnvService);
    await envService.enabled(call.request.ids);
    callback(null, { code: 200 });
  } catch (e: any) {
    callback(e);
  }
};

export const updateEnvNames = async (
  call: ServerUnaryCall<UpdateEnvNamesRequest, Response>,
  callback: sendUnaryData<Response>,
) => {
  try {
    if (!call.request.ids || call.request.ids.length === 0) {
      return callback(null, {
        code: 400,
        message: 'ids parameter is required',
      });
    }

    const envService = Container.get(EnvService);
    await envService.updateNames({
      ids: call.request.ids,
      name: call.request.name,
    });
    callback(null, { code: 200 });
  } catch (e: any) {
    callback(e);
  }
};

export const getEnvById = async (
  call: ServerUnaryCall<GetEnvByIdRequest, EnvResponse>,
  callback: sendUnaryData<EnvResponse>,
) => {
  try {
    if (!call.request.id) {
      return callback(null, {
        code: 400,
        data: undefined,
        message: 'id parameter is required',
      });
    }

    const envService = Container.get(EnvService);
    const data = await envService.getDb({ id: call.request.id });
    callback(null, {
      code: 200,
      data: { ...data, remarks: data.remarks || '' },
    });
  } catch (e: any) {
    callback(e);
  }
};

export const systemNotify = async (
  call: ServerUnaryCall<SystemNotifyRequest, Response>,
  callback: sendUnaryData<Response>,
) => {
  try {
    const systemService = Container.get(SystemService);
    const data = await systemService.notify({
      title: call.request.title,
      content: call.request.content,
      notificationInfo: call.request.notificationInfo as unknown as NotificationInfo,
    });
    callback(null, data);
  } catch (e: any) {
    callback(e);
  }
};

const normalizeCronData = (data: CronItem | null): CronItem | undefined => {
  if (!data) return undefined;
  return {
    ...data,
    sub_id: data.sub_id ?? undefined,
    extra_schedules: data.extra_schedules ?? undefined,
    pid: data.pid ?? undefined,
    task_before: data.task_before ?? undefined,
    task_after: data.task_after ?? undefined,
  };
};

export const getCronDetail = async (
  call: ServerUnaryCall<CronDetailRequest, CronDetailResponse>,
  callback: sendUnaryData<CronDetailResponse>,
) => {
  try {
    if (!call.request.log_path) {
      return callback(null, {
        code: 400,
        data: undefined,
        message: 'log_path is required',
      });
    }
    const cronService = Container.get(CronService);
    const data = (await cronService.find({
      log_path: call.request.log_path,
    })) as CronItem;
    callback(null, { code: 200, data: normalizeCronData(data) });
  } catch (e: any) {
    callback(e);
  }
};

export const createCron = async (
  call: ServerUnaryCall<CreateCronRequest, CronResponse>,
  callback: sendUnaryData<CronResponse>,
) => {
  try {
    const cronService = Container.get(CronService);
    const data = (await cronService.create(call.request)) as CronItem;
    callback(null, { code: 200, data: normalizeCronData(data) });
  } catch (e: any) {
    callback(e);
  }
};

export const updateCron = async (
  call: ServerUnaryCall<UpdateCronRequest, CronResponse>,
  callback: sendUnaryData<CronResponse>,
) => {
  try {
    const cronService = Container.get(CronService);
    const { id, ...fields } = call.request;

    const updateRequest = {
      id,
      ...Object.entries(fields).reduce((acc: any, [key, value]) => {
        if (value !== undefined) {
          acc[key] = value;
        }
        return acc;
      }, {}),
    } as UpdateCronRequest;

    const data = (await cronService.update(updateRequest)) as CronItem;
    callback(null, { code: 200, data: normalizeCronData(data) });
  } catch (e: any) {
    callback(e);
  }
};

export const deleteCrons = async (
  call: ServerUnaryCall<DeleteCronsRequest, Response>,
  callback: sendUnaryData<Response>,
) => {
  try {
    const cronService = Container.get(CronService);
    await cronService.remove(call.request.ids);
    callback(null, { code: 200 });
  } catch (e: any) {
    callback(e);
  }
};

export const getCrons = async (
  call: ServerUnaryCall<GetCronsRequest, CronsResponse>,
  callback: sendUnaryData<CronsResponse>,
) => {
  try {
    const cronService = Container.get(CronService);
    const result = await cronService.crontabs({
      searchValue: call.request.searchValue || '',
      page: '0',
      size: '0',
      sorter: '',
      filters: '',
      queryString: '',
    });
    const data = result.data.map((x) => normalizeCronData(x as CronItem));
    callback(null, {
      code: 200,
      data: data.filter((x): x is CronItem => x !== undefined),
    });
  } catch (e: any) {
    callback(null, {
      code: 500,
      data: [],
      message: e.message,
    });
  }
};

export const getCronById = async (
  call: ServerUnaryCall<GetCronByIdRequest, CronResponse>,
  callback: sendUnaryData<CronResponse>,
) => {
  try {
    if (!call.request.id) {
      return callback(null, {
        code: 400,
        data: undefined,
        message: 'id parameter is required',
      });
    }

    const cronService = Container.get(CronService);
    const data = (await cronService.getDb({ id: call.request.id })) as CronItem;
    callback(null, { code: 200, data: normalizeCronData(data) });
  } catch (e: any) {
    callback(null, {
      code: 404,
      data: undefined,
      message: e.message,
    });
  }
};

export const enableCrons = async (
  call: ServerUnaryCall<EnableCronsRequest, Response>,
  callback: sendUnaryData<Response>,
) => {
  try {
    if (!call.request.ids || call.request.ids.length === 0) {
      return callback(null, {
        code: 400,
        message: 'ids parameter is required',
      });
    }

    const cronService = Container.get(CronService);
    await cronService.enabled(call.request.ids);
    callback(null, { code: 200 });
  } catch (e: any) {
    callback(e);
  }
};

export const disableCrons = async (
  call: ServerUnaryCall<DisableCronsRequest, Response>,
  callback: sendUnaryData<Response>,
) => {
  try {
    if (!call.request.ids || call.request.ids.length === 0) {
      return callback(null, {
        code: 400,
        message: 'ids parameter is required',
      });
    }

    const cronService = Container.get(CronService);
    await cronService.disabled(call.request.ids);
    callback(null, { code: 200 });
  } catch (e: any) {
    callback(e);
  }
};

export const runCrons = async (
  call: ServerUnaryCall<RunCronsRequest, Response>,
  callback: sendUnaryData<Response>,
) => {
  try {
    if (!call.request.ids || call.request.ids.length === 0) {
      return callback(null, {
        code: 400,
        message: 'ids parameter is required',
      });
    }

    const cronService = Container.get(CronService);
    await cronService.run(call.request.ids);
    callback(null, { code: 200 });
  } catch (e: any) {
    callback(e);
  }
};
