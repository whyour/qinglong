import { Document, Model } from 'mongoose';
import { IContent } from '../../interfaces/IContent';
import { ICommon } from '../../interfaces/ICommon';
declare global {
  namespace Models {
    export type IContentModel = Model<IContent & Document>;
    export type ICommonModel = Model<ICommon & Document>;
  }
}
