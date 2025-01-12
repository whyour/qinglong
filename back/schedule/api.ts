import 'reflect-metadata';
import { Container } from 'typedi';
import EnvService from '../services/env';
import { sendUnaryData, ServerUnaryCall } from '@grpc/grpc-js';
import {
  CreateEnvRequest,
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
    const envService = Container.get(EnvService);
    const data = await envService.update(
      pick(call.request.env, ['id', 'name', 'value', 'remark']) as EnvItem,
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
    const data = await systemService.notify(call.request);
    callback(null, data);
  } catch (e: any) {
    callback(e);
  }
};
