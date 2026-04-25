import { KvBlockDevice } from '../../block-devices';
import { dataView } from '../../utils';

export type INodeId = number;

export abstract class INode<DataType> {
    public readonly id: INodeId;
    public blockDevice: KvBlockDevice;

    public creationTime: Date = new Date(0);
    public modificationTime: Date = new Date(0);

    constructor(blockDevice: KvBlockDevice, id: INodeId) {
        this.blockDevice = blockDevice;
        this.id = id;
    }

    async init(): Promise<void> {
        const buffer = await this.blockDevice.readBlock(this.id);
        const view = dataView(buffer);

        const creationTimeMs = view.getInt32(0);
        const modificationTimeMs = view.getInt32(4);

        this.creationTime = new Date(creationTimeMs);
        this.modificationTime = new Date(modificationTimeMs);
    }

    protected abstract read(): Promise<DataType>;

    protected abstract write(data: DataType): Promise<void>;
}
