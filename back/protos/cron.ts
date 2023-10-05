/* eslint-disable */
import {
  CallOptions,
  ChannelCredentials,
  Client,
  ClientOptions,
  ClientUnaryCall,
  handleUnaryCall,
  makeGenericClientConstructor,
  Metadata,
  ServiceError,
  UntypedServiceImplementation,
} from "@grpc/grpc-js";
import _m0 from "protobufjs/minimal";

export const protobufPackage = "com.ql.cron";

export interface ISchedule {
  schedule: string;
}

export interface ICron {
  id: string;
  schedule: string;
  command: string;
  extraSchedules: ISchedule[];
  name: string;
}

export interface AddCronRequest {
  crons: ICron[];
}

export interface AddCronResponse {
}

export interface DeleteCronRequest {
  ids: string[];
}

export interface DeleteCronResponse {
}

function createBaseISchedule(): ISchedule {
  return { schedule: "" };
}

export const ISchedule = {
  encode(message: ISchedule, writer: _m0.Writer = _m0.Writer.create()): _m0.Writer {
    if (message.schedule !== "") {
      writer.uint32(10).string(message.schedule);
    }
    return writer;
  },

  decode(input: _m0.Reader | Uint8Array, length?: number): ISchedule {
    const reader = input instanceof _m0.Reader ? input : _m0.Reader.create(input);
    let end = length === undefined ? reader.len : reader.pos + length;
    const message = createBaseISchedule();
    while (reader.pos < end) {
      const tag = reader.uint32();
      switch (tag >>> 3) {
        case 1:
          if (tag !== 10) {
            break;
          }

          message.schedule = reader.string();
          continue;
      }
      if ((tag & 7) === 4 || tag === 0) {
        break;
      }
      reader.skipType(tag & 7);
    }
    return message;
  },

  fromJSON(object: any): ISchedule {
    return { schedule: isSet(object.schedule) ? String(object.schedule) : "" };
  },

  toJSON(message: ISchedule): unknown {
    const obj: any = {};
    message.schedule !== undefined && (obj.schedule = message.schedule);
    return obj;
  },

  create<I extends Exact<DeepPartial<ISchedule>, I>>(base?: I): ISchedule {
    return ISchedule.fromPartial(base ?? {});
  },

  fromPartial<I extends Exact<DeepPartial<ISchedule>, I>>(object: I): ISchedule {
    const message = createBaseISchedule();
    message.schedule = object.schedule ?? "";
    return message;
  },
};

function createBaseICron(): ICron {
  return { id: "", schedule: "", command: "", extraSchedules: [], name: "" };
}

export const ICron = {
  encode(message: ICron, writer: _m0.Writer = _m0.Writer.create()): _m0.Writer {
    if (message.id !== "") {
      writer.uint32(10).string(message.id);
    }
    if (message.schedule !== "") {
      writer.uint32(18).string(message.schedule);
    }
    if (message.command !== "") {
      writer.uint32(26).string(message.command);
    }
    for (const v of message.extraSchedules) {
      ISchedule.encode(v!, writer.uint32(34).fork()).ldelim();
    }
    if (message.name !== "") {
      writer.uint32(42).string(message.name);
    }
    return writer;
  },

  decode(input: _m0.Reader | Uint8Array, length?: number): ICron {
    const reader = input instanceof _m0.Reader ? input : _m0.Reader.create(input);
    let end = length === undefined ? reader.len : reader.pos + length;
    const message = createBaseICron();
    while (reader.pos < end) {
      const tag = reader.uint32();
      switch (tag >>> 3) {
        case 1:
          if (tag !== 10) {
            break;
          }

          message.id = reader.string();
          continue;
        case 2:
          if (tag !== 18) {
            break;
          }

          message.schedule = reader.string();
          continue;
        case 3:
          if (tag !== 26) {
            break;
          }

          message.command = reader.string();
          continue;
        case 4:
          if (tag !== 34) {
            break;
          }

          message.extraSchedules.push(ISchedule.decode(reader, reader.uint32()));
          continue;
        case 5:
          if (tag !== 42) {
            break;
          }

          message.name = reader.string();
          continue;
      }
      if ((tag & 7) === 4 || tag === 0) {
        break;
      }
      reader.skipType(tag & 7);
    }
    return message;
  },

  fromJSON(object: any): ICron {
    return {
      id: isSet(object.id) ? String(object.id) : "",
      schedule: isSet(object.schedule) ? String(object.schedule) : "",
      command: isSet(object.command) ? String(object.command) : "",
      extraSchedules: Array.isArray(object?.extraSchedules)
        ? object.extraSchedules.map((e: any) => ISchedule.fromJSON(e))
        : [],
      name: isSet(object.name) ? String(object.name) : "",
    };
  },

  toJSON(message: ICron): unknown {
    const obj: any = {};
    message.id !== undefined && (obj.id = message.id);
    message.schedule !== undefined && (obj.schedule = message.schedule);
    message.command !== undefined && (obj.command = message.command);
    if (message.extraSchedules) {
      obj.extraSchedules = message.extraSchedules.map((e) => e ? ISchedule.toJSON(e) : undefined);
    } else {
      obj.extraSchedules = [];
    }
    message.name !== undefined && (obj.name = message.name);
    return obj;
  },

  create<I extends Exact<DeepPartial<ICron>, I>>(base?: I): ICron {
    return ICron.fromPartial(base ?? {});
  },

  fromPartial<I extends Exact<DeepPartial<ICron>, I>>(object: I): ICron {
    const message = createBaseICron();
    message.id = object.id ?? "";
    message.schedule = object.schedule ?? "";
    message.command = object.command ?? "";
    message.extraSchedules = object.extraSchedules?.map((e) => ISchedule.fromPartial(e)) || [];
    message.name = object.name ?? "";
    return message;
  },
};

function createBaseAddCronRequest(): AddCronRequest {
  return { crons: [] };
}

export const AddCronRequest = {
  encode(message: AddCronRequest, writer: _m0.Writer = _m0.Writer.create()): _m0.Writer {
    for (const v of message.crons) {
      ICron.encode(v!, writer.uint32(10).fork()).ldelim();
    }
    return writer;
  },

  decode(input: _m0.Reader | Uint8Array, length?: number): AddCronRequest {
    const reader = input instanceof _m0.Reader ? input : _m0.Reader.create(input);
    let end = length === undefined ? reader.len : reader.pos + length;
    const message = createBaseAddCronRequest();
    while (reader.pos < end) {
      const tag = reader.uint32();
      switch (tag >>> 3) {
        case 1:
          if (tag !== 10) {
            break;
          }

          message.crons.push(ICron.decode(reader, reader.uint32()));
          continue;
      }
      if ((tag & 7) === 4 || tag === 0) {
        break;
      }
      reader.skipType(tag & 7);
    }
    return message;
  },

  fromJSON(object: any): AddCronRequest {
    return { crons: Array.isArray(object?.crons) ? object.crons.map((e: any) => ICron.fromJSON(e)) : [] };
  },

  toJSON(message: AddCronRequest): unknown {
    const obj: any = {};
    if (message.crons) {
      obj.crons = message.crons.map((e) => e ? ICron.toJSON(e) : undefined);
    } else {
      obj.crons = [];
    }
    return obj;
  },

  create<I extends Exact<DeepPartial<AddCronRequest>, I>>(base?: I): AddCronRequest {
    return AddCronRequest.fromPartial(base ?? {});
  },

  fromPartial<I extends Exact<DeepPartial<AddCronRequest>, I>>(object: I): AddCronRequest {
    const message = createBaseAddCronRequest();
    message.crons = object.crons?.map((e) => ICron.fromPartial(e)) || [];
    return message;
  },
};

function createBaseAddCronResponse(): AddCronResponse {
  return {};
}

export const AddCronResponse = {
  encode(_: AddCronResponse, writer: _m0.Writer = _m0.Writer.create()): _m0.Writer {
    return writer;
  },

  decode(input: _m0.Reader | Uint8Array, length?: number): AddCronResponse {
    const reader = input instanceof _m0.Reader ? input : _m0.Reader.create(input);
    let end = length === undefined ? reader.len : reader.pos + length;
    const message = createBaseAddCronResponse();
    while (reader.pos < end) {
      const tag = reader.uint32();
      switch (tag >>> 3) {
      }
      if ((tag & 7) === 4 || tag === 0) {
        break;
      }
      reader.skipType(tag & 7);
    }
    return message;
  },

  fromJSON(_: any): AddCronResponse {
    return {};
  },

  toJSON(_: AddCronResponse): unknown {
    const obj: any = {};
    return obj;
  },

  create<I extends Exact<DeepPartial<AddCronResponse>, I>>(base?: I): AddCronResponse {
    return AddCronResponse.fromPartial(base ?? {});
  },

  fromPartial<I extends Exact<DeepPartial<AddCronResponse>, I>>(_: I): AddCronResponse {
    const message = createBaseAddCronResponse();
    return message;
  },
};

function createBaseDeleteCronRequest(): DeleteCronRequest {
  return { ids: [] };
}

export const DeleteCronRequest = {
  encode(message: DeleteCronRequest, writer: _m0.Writer = _m0.Writer.create()): _m0.Writer {
    for (const v of message.ids) {
      writer.uint32(10).string(v!);
    }
    return writer;
  },

  decode(input: _m0.Reader | Uint8Array, length?: number): DeleteCronRequest {
    const reader = input instanceof _m0.Reader ? input : _m0.Reader.create(input);
    let end = length === undefined ? reader.len : reader.pos + length;
    const message = createBaseDeleteCronRequest();
    while (reader.pos < end) {
      const tag = reader.uint32();
      switch (tag >>> 3) {
        case 1:
          if (tag !== 10) {
            break;
          }

          message.ids.push(reader.string());
          continue;
      }
      if ((tag & 7) === 4 || tag === 0) {
        break;
      }
      reader.skipType(tag & 7);
    }
    return message;
  },

  fromJSON(object: any): DeleteCronRequest {
    return { ids: Array.isArray(object?.ids) ? object.ids.map((e: any) => String(e)) : [] };
  },

  toJSON(message: DeleteCronRequest): unknown {
    const obj: any = {};
    if (message.ids) {
      obj.ids = message.ids.map((e) => e);
    } else {
      obj.ids = [];
    }
    return obj;
  },

  create<I extends Exact<DeepPartial<DeleteCronRequest>, I>>(base?: I): DeleteCronRequest {
    return DeleteCronRequest.fromPartial(base ?? {});
  },

  fromPartial<I extends Exact<DeepPartial<DeleteCronRequest>, I>>(object: I): DeleteCronRequest {
    const message = createBaseDeleteCronRequest();
    message.ids = object.ids?.map((e) => e) || [];
    return message;
  },
};

function createBaseDeleteCronResponse(): DeleteCronResponse {
  return {};
}

export const DeleteCronResponse = {
  encode(_: DeleteCronResponse, writer: _m0.Writer = _m0.Writer.create()): _m0.Writer {
    return writer;
  },

  decode(input: _m0.Reader | Uint8Array, length?: number): DeleteCronResponse {
    const reader = input instanceof _m0.Reader ? input : _m0.Reader.create(input);
    let end = length === undefined ? reader.len : reader.pos + length;
    const message = createBaseDeleteCronResponse();
    while (reader.pos < end) {
      const tag = reader.uint32();
      switch (tag >>> 3) {
      }
      if ((tag & 7) === 4 || tag === 0) {
        break;
      }
      reader.skipType(tag & 7);
    }
    return message;
  },

  fromJSON(_: any): DeleteCronResponse {
    return {};
  },

  toJSON(_: DeleteCronResponse): unknown {
    const obj: any = {};
    return obj;
  },

  create<I extends Exact<DeepPartial<DeleteCronResponse>, I>>(base?: I): DeleteCronResponse {
    return DeleteCronResponse.fromPartial(base ?? {});
  },

  fromPartial<I extends Exact<DeepPartial<DeleteCronResponse>, I>>(_: I): DeleteCronResponse {
    const message = createBaseDeleteCronResponse();
    return message;
  },
};

export type CronService = typeof CronService;
export const CronService = {
  addCron: {
    path: "/com.ql.cron.Cron/addCron",
    requestStream: false,
    responseStream: false,
    requestSerialize: (value: AddCronRequest) => Buffer.from(AddCronRequest.encode(value).finish()),
    requestDeserialize: (value: Buffer) => AddCronRequest.decode(value),
    responseSerialize: (value: AddCronResponse) => Buffer.from(AddCronResponse.encode(value).finish()),
    responseDeserialize: (value: Buffer) => AddCronResponse.decode(value),
  },
  delCron: {
    path: "/com.ql.cron.Cron/delCron",
    requestStream: false,
    responseStream: false,
    requestSerialize: (value: DeleteCronRequest) => Buffer.from(DeleteCronRequest.encode(value).finish()),
    requestDeserialize: (value: Buffer) => DeleteCronRequest.decode(value),
    responseSerialize: (value: DeleteCronResponse) => Buffer.from(DeleteCronResponse.encode(value).finish()),
    responseDeserialize: (value: Buffer) => DeleteCronResponse.decode(value),
  },
} as const;

export interface CronServer extends UntypedServiceImplementation {
  addCron: handleUnaryCall<AddCronRequest, AddCronResponse>;
  delCron: handleUnaryCall<DeleteCronRequest, DeleteCronResponse>;
}

export interface CronClient extends Client {
  addCron(
    request: AddCronRequest,
    callback: (error: ServiceError | null, response: AddCronResponse) => void,
  ): ClientUnaryCall;
  addCron(
    request: AddCronRequest,
    metadata: Metadata,
    callback: (error: ServiceError | null, response: AddCronResponse) => void,
  ): ClientUnaryCall;
  addCron(
    request: AddCronRequest,
    metadata: Metadata,
    options: Partial<CallOptions>,
    callback: (error: ServiceError | null, response: AddCronResponse) => void,
  ): ClientUnaryCall;
  delCron(
    request: DeleteCronRequest,
    callback: (error: ServiceError | null, response: DeleteCronResponse) => void,
  ): ClientUnaryCall;
  delCron(
    request: DeleteCronRequest,
    metadata: Metadata,
    callback: (error: ServiceError | null, response: DeleteCronResponse) => void,
  ): ClientUnaryCall;
  delCron(
    request: DeleteCronRequest,
    metadata: Metadata,
    options: Partial<CallOptions>,
    callback: (error: ServiceError | null, response: DeleteCronResponse) => void,
  ): ClientUnaryCall;
}

export const CronClient = makeGenericClientConstructor(CronService, "com.ql.cron.Cron") as unknown as {
  new (address: string, credentials: ChannelCredentials, options?: Partial<ClientOptions>): CronClient;
  service: typeof CronService;
};

type Builtin = Date | Function | Uint8Array | string | number | boolean | undefined;

export type DeepPartial<T> = T extends Builtin ? T
  : T extends Array<infer U> ? Array<DeepPartial<U>> : T extends ReadonlyArray<infer U> ? ReadonlyArray<DeepPartial<U>>
  : T extends {} ? { [K in keyof T]?: DeepPartial<T[K]> }
  : Partial<T>;

type KeysOfUnion<T> = T extends T ? keyof T : never;
export type Exact<P, I extends P> = P extends Builtin ? P
  : P & { [K in keyof P]: Exact<P[K], I[K]> } & { [K in Exclude<keyof I, KeysOfUnion<P>>]: never };

function isSet(value: any): boolean {
  return value !== null && value !== undefined;
}
