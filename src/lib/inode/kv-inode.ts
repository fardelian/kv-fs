import { KvBlockDevice } from '../block-device/types';

export abstract class INode<DataType> {
    public readonly id: number;
    public readonly creationTime: Date;
    public modificationTime: Date;
    public readonly blockDevice: KvBlockDevice;

    protected constructor(blockDevice: KvBlockDevice, id: number) {
        this.id = id;
        this.blockDevice = blockDevice;

        const buffer = this.blockDevice.readBlock(this.id);

        const creationTimeMs = buffer.readBigUInt64BE(0);
        const modificationTimeMs = buffer.readBigUInt64BE(8);

        this.creationTime = new Date(Number(creationTimeMs));
        this.modificationTime = new Date(Number(modificationTimeMs));
    }

    public abstract read(): DataType;

    public abstract write(data: DataType): void;
}
