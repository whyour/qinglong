export interface ICommon {
  _id: string;
  value: String;
  name: String;
  type: Number;
}

export interface ICommonInputDTO {
  value: String;
  name: String;
  type: Number;
}

export enum ShareCodeType {
  ddFactory = 1,
  ddXw,
  jxCfd,
  jxFactory,
  jxFactoryTuan,
  jxNc,
  jxStory,
  jxCfdGroup,
  jdZz,
  jdZjdTuan,
  didi,
  jd818,
}
