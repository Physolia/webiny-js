import pick from "lodash/pick";
import { CmsEntry } from "@webiny/api-headless-cms/types";
import { Filter } from "~/filter/filter.types";
import { Folder } from "~/folder/folder.types";
import { SearchRecord } from "~/record/record.types";

export function getRecordFieldValues(entry: CmsEntry<any>, fields?: string[]) {
    return {
        ...(fields ? pick(entry, fields) : entry),
        ...entry.values
    } as SearchRecord<any>;
}

export function getFolderFieldValues(entry: CmsEntry, fields: string[]) {
    return { ...pick(entry, fields), ...entry.values } as Folder;
}

export function getFilterFieldValues(entry: CmsEntry, fields: string[]) {
    return { ...pick(entry, fields), id: entry.entryId, ...entry.values } as Filter;
}
