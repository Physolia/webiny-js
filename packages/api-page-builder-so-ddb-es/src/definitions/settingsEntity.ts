import { Entity, Table } from "dynamodb-toolbox";

interface Params {
    table: Table;
    entityName: string;
}

export const createSettingsEntity = (params: Params): Entity<any> => {
    const { entityName, table } = params;
    return new Entity({
        name: entityName,
        table,
        attributes: {
            PK: {
                partitionKey: true
            },
            SK: {
                sortKey: true
            },
            TYPE: {
                type: "string"
            },
            data: {
                type: "map"
            }
        }
    });
};
