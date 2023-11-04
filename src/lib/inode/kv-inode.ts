import { KvBlockDevice } from '../block-device/types';

export type INodeId = number;

export abstract class INode<DataType> {
    public readonly id: INodeId;
    public blockDevice: KvBlockDevice;

    public creationTime: Date = new Date(0);
    public modificationTime: Date = new Date(0);

    protected constructor(blockDevice: KvBlockDevice, id: INodeId) {
        this.blockDevice = blockDevice;
        this.id = id;
    }

    public async init(): Promise<this> {
        const buffer = await this.blockDevice.readBlock(this.id);

        const creationTimeMs = buffer.readBigUInt64BE(0);
        const modificationTimeMs = buffer.readBigUInt64BE(8);

        this.creationTime = new Date(Number(creationTimeMs));
        this.modificationTime = new Date(Number(modificationTimeMs));

        return this;
    }

    protected abstract read(): Promise<DataType>;

    protected abstract write(data: DataType): Promise<void>;
}
