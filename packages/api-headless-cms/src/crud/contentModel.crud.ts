import WebinyError from "@webiny/error";
import {
    CmsContext,
    CmsModel,
    CmsModelContext,
    CmsModelGroup,
    CmsModelManager,
    CmsModelUpdateInput,
    HeadlessCmsStorageOperations,
    OnModelAfterCreateFromTopicParams,
    OnModelAfterCreateTopicParams,
    OnModelAfterDeleteTopicParams,
    OnModelAfterUpdateTopicParams,
    OnModelBeforeCreateFromTopicParams,
    OnModelBeforeCreateTopicParams,
    OnModelBeforeDeleteTopicParams,
    OnModelBeforeUpdateTopicParams,
    OnModelCreateErrorTopicParams,
    OnModelCreateFromErrorParams,
    OnModelDeleteErrorTopicParams,
    OnModelInitializeParams,
    OnModelUpdateErrorTopicParams
} from "~/types";
import { NotFoundError } from "@webiny/handler-graphql";
import { contentModelManagerFactory } from "./contentModel/contentModelManagerFactory";
import { Tenant } from "@webiny/api-tenancy/types";
import { I18NLocale } from "@webiny/api-i18n/types";
import { SecurityIdentity } from "@webiny/api-security/types";
import { createTopic } from "@webiny/pubsub";
import { assignModelBeforeCreate } from "./contentModel/beforeCreate";
import { assignModelBeforeUpdate } from "./contentModel/beforeUpdate";
import { assignModelBeforeDelete } from "./contentModel/beforeDelete";
import { CmsModelPlugin } from "~/plugins/CmsModelPlugin";
import { filterAsync } from "~/utils/filterAsync";
import {
    createModelCreateFromValidation,
    createModelCreateValidation,
    createModelUpdateValidation
} from "~/crud/contentModel/validation";
import { createZodError, removeUndefinedValues } from "@webiny/utils";
import { assignModelDefaultFields } from "~/crud/contentModel/defaultFields";
import { ModelsPermissions } from "~/utils/permissions/ModelsPermissions";
import { createCacheKey, createMemoryCache } from "~/utils";
import { ensureTypeTag } from "./contentModel/ensureTypeTag";
import { listModelsFromDatabase } from "~/crud/contentModel/listModelsFromDatabase";

export interface CreateModelsCrudParams {
    getTenant: () => Tenant;
    getLocale: () => I18NLocale;
    storageOperations: HeadlessCmsStorageOperations;
    modelsPermissions: ModelsPermissions;
    context: CmsContext;
    getIdentity: () => SecurityIdentity;
}

export const createModelsCrud = (params: CreateModelsCrudParams): CmsModelContext => {
    const { getTenant, getIdentity, getLocale, storageOperations, modelsPermissions, context } =
        params;

    const listPluginModelsCache = createMemoryCache<CmsModel[]>();
    const listAllModelsCache = createMemoryCache<Promise<CmsModel[]>>();
    const clearModelsCache = (): void => {
        listAllModelsCache.clear();
        listPluginModelsCache.clear();
    };

    const managers = new Map<string, CmsModelManager>();
    const updateManager = async (
        context: CmsContext,
        model: CmsModel
    ): Promise<CmsModelManager> => {
        const manager = await contentModelManagerFactory(context, model);
        managers.set(model.modelId, manager);
        return manager;
    };

    const checkModelPermissions = async (rwd: string) => {
        return modelsPermissions.ensure({ rwd });
    };

    const getModelsAsPlugins = (tenant: string, locale: string): CmsModel[] => {
        const modelPlugins = context.plugins.byType<CmsModelPlugin>(CmsModelPlugin.type);
        const cacheKey = createCacheKey({
            tenant,
            locale,
            models: modelPlugins.map(({ contentModel: model }) => {
                return `${model.modelId}#${model.pluralApiName}#${model.singularApiName}#${
                    model.savedOn || "unknown"
                }`;
            })
        });
        return listPluginModelsCache.getOrSet(cacheKey, () => {
            return (
                modelPlugins
                    /**
                     * We need to filter out models that are not for this tenant or locale.
                     * If it does not have tenant or locale define, it is for every locale and tenant
                     */
                    .filter(plugin => {
                        const { tenant: modelTenant, locale: modelLocale } = plugin.contentModel;
                        if (modelTenant && modelTenant !== tenant) {
                            return false;
                        } else if (modelLocale && modelLocale !== locale) {
                            return false;
                        }
                        return true;
                    })
                    .map(plugin => {
                        return {
                            ...plugin.contentModel,
                            tags: ensureTypeTag(plugin.contentModel),
                            tenant,
                            locale,
                            webinyVersion: context.WEBINY_VERSION
                        };
                    })
            );
        });
    };

    const getModelFromCache = async (modelId: string) => {
        const models = await listModels();
        const model = models.find(m => m.modelId === modelId);
        if (!model) {
            throw new NotFoundError(`Content model "${modelId}" was not found!`);
        }

        return {
            ...model,
            tags: ensureTypeTag(model),
            tenant: model.tenant || getTenant().id,
            locale: model.locale || getLocale().code
        };
    };

    /**
     * The list models cache is a key -> Promise pair so it the listModels() can be called multiple times but executed only once.
     */
    const listModels = async () => {
        /**
         * Maybe we can cache based on permissions, not the identity id?
         *
         * TODO: @adrian please check if possible.
         */
        const tenant = getTenant().id;
        const locale = getLocale().code;
        const pluginModels = getModelsAsPlugins(tenant, locale);
        const cacheKey = createCacheKey({
            tenant,
            locale,
            identity: context.security.isAuthorizationEnabled() ? getIdentity()?.id : undefined,
            plugins: pluginModels.map(model => {
                return `${model.modelId}#${model.pluralApiName}#${model.singularApiName}#${
                    model.savedOn || "unknown"
                }`;
            })
        });

        return listAllModelsCache.getOrSet(cacheKey, async () => {
            return context.benchmark.measure("headlessCms.crud.models.listModels", async () => {
                const databaseModels = await listModelsFromDatabase(params);
                const models = databaseModels.concat(pluginModels);
                /**
                 * Filter models based on permissions.
                 */
                return filterAsync(models, async model => {
                    const ownsModel = await modelsPermissions.ensure(
                        { owns: model.createdBy },
                        { throw: false }
                    );

                    if (!ownsModel) {
                        return false;
                    }

                    return modelsPermissions.canAccessModel({
                        model
                    });
                });
            });
        });
    };

    const getModel = async (modelId: string): Promise<CmsModel> => {
        return context.benchmark.measure("headlessCms.crud.models.getModel", async () => {
            await checkModelPermissions("r");

            const model = await context.security.withoutAuthorization(async () => {
                return await getModelFromCache(modelId);
            });
            if (!model) {
                throw new NotFoundError(`Content model "${modelId}" was not found!`);
            }

            await modelsPermissions.ensure({ owns: model.createdBy });
            await modelsPermissions.ensureCanAccessModel({
                model
            });

            return model;
        });
    };

    const getEntryManager: CmsModelContext["getEntryManager"] = async (
        target
    ): Promise<CmsModelManager> => {
        const modelId = typeof target === "string" ? target : target.modelId;
        if (managers.has(modelId)) {
            return managers.get(modelId) as CmsModelManager;
        }
        const model = await getModelFromCache(modelId);
        return await updateManager(context, model);
    };

    /**
     * Create
     */
    const onModelBeforeCreate =
        createTopic<OnModelBeforeCreateTopicParams>("cms.onModelBeforeCreate");
    const onModelAfterCreate = createTopic<OnModelAfterCreateTopicParams>("cms.onModelAfterCreate");
    const onModelCreateError = createTopic<OnModelCreateErrorTopicParams>("cms.onModelCreateError");
    /**
     * Create from / clone
     */
    const onModelBeforeCreateFrom = createTopic<OnModelBeforeCreateFromTopicParams>(
        "cms.onModelBeforeCreateFrom"
    );
    const onModelAfterCreateFrom = createTopic<OnModelAfterCreateFromTopicParams>(
        "cms.onModelAfterCreateFrom"
    );
    const onModelCreateFromError = createTopic<OnModelCreateFromErrorParams>(
        "cms.onModelCreateFromError"
    );
    /**
     * Update
     */
    const onModelBeforeUpdate =
        createTopic<OnModelBeforeUpdateTopicParams>("cms.onModelBeforeUpdate");
    const onModelAfterUpdate = createTopic<OnModelAfterUpdateTopicParams>("cms.onModelAfterUpdate");
    const onModelUpdateError = createTopic<OnModelUpdateErrorTopicParams>("cms.onModelUpdateError");
    /**
     * Delete
     */
    const onModelBeforeDelete =
        createTopic<OnModelBeforeDeleteTopicParams>("cms.onModelBeforeDelete");
    const onModelAfterDelete = createTopic<OnModelAfterDeleteTopicParams>("cms.onModelAfterDelete");
    const onModelDeleteError = createTopic<OnModelDeleteErrorTopicParams>("cms.onModelDeleteError");
    /**
     * Initialize
     */
    const onModelInitialize = createTopic<OnModelInitializeParams>("cms.onModelInitialize");
    /**
     * We need to assign some default behaviors.
     */
    assignModelBeforeCreate({
        onModelBeforeCreate,
        onModelBeforeCreateFrom,
        context,
        storageOperations
    });
    assignModelBeforeUpdate({
        onModelBeforeUpdate,
        context
    });
    assignModelBeforeDelete({
        onModelBeforeDelete,
        plugins: context.plugins,
        storageOperations
    });

    /**
     * CRUD methods
     */
    const createModel: CmsModelContext["createModel"] = async input => {
        await checkModelPermissions("w");

        const result = await createModelCreateValidation().safeParseAsync(input);
        if (!result.success) {
            throw createZodError(result.error);
        }
        /**
         * We need to extract the defaultFields because it is not for the CmsModel object.
         */
        const { defaultFields, ...data } = removeUndefinedValues(result.data);
        if (defaultFields) {
            assignModelDefaultFields(data);
        }

        const group = await context.cms.getGroup(data.group);

        const identity = getIdentity();
        const model: CmsModel = {
            ...data,
            modelId: data.modelId || "",
            singularApiName: data.singularApiName,
            pluralApiName: data.pluralApiName,
            titleFieldId: "id",
            descriptionFieldId: null,
            imageFieldId: null,
            description: data.description || "",
            locale: getLocale().code,
            tenant: getTenant().id,
            group: {
                id: group.id,
                name: group.name
            },
            createdBy: {
                id: identity.id,
                displayName: identity.displayName,
                type: identity.type
            },
            createdOn: new Date().toISOString(),
            savedOn: new Date().toISOString(),
            lockedFields: [],
            webinyVersion: context.WEBINY_VERSION
        };

        model.tags = ensureTypeTag(model);

        try {
            await onModelBeforeCreate.publish({
                input: data,
                model
            });

            const createdModel = await storageOperations.models.create({
                model
            });

            clearModelsCache();

            await updateManager(context, model);

            await onModelAfterCreate.publish({
                input: data,
                model: createdModel
            });

            return createdModel;
        } catch (ex) {
            await onModelCreateError.publish({
                input: data,
                model,
                error: ex
            });
            throw ex;
        }
    };
    const updateModel: CmsModelContext["updateModel"] = async (modelId, input) => {
        await checkModelPermissions("w");

        // Get a model record; this will also perform ownership validation.
        const original = await getModel(modelId);

        const result = await createModelUpdateValidation().safeParseAsync(input);
        if (!result.success) {
            throw createZodError(result.error);
        }

        const data = removeUndefinedValues(result.data);

        if (Object.keys(data).length === 0) {
            /**
             * We need to return the original if nothing is to be updated.
             */
            return original;
        }
        let group: CmsModelGroup = {
            id: original.group.id,
            name: original.group.name
        };
        const groupId = data.group;
        if (groupId) {
            const groupData = await context.cms.getGroup(groupId);
            group = {
                id: groupData.id,
                name: groupData.name
            };
        }
        const model: CmsModel = {
            ...original,
            ...data,
            titleFieldId:
                data.titleFieldId === undefined
                    ? original.titleFieldId
                    : (data.titleFieldId as string),
            descriptionFieldId:
                data.descriptionFieldId === undefined
                    ? original.descriptionFieldId
                    : data.descriptionFieldId,
            imageFieldId:
                data.imageFieldId === undefined ? original.imageFieldId : data.imageFieldId,
            group,
            description: data.description || original.description,
            tenant: original.tenant || getTenant().id,
            locale: original.locale || getLocale().code,
            webinyVersion: context.WEBINY_VERSION,
            savedOn: new Date().toISOString()
        };

        model.tags = ensureTypeTag(model);

        try {
            await onModelBeforeUpdate.publish({
                input: data,
                original,
                model
            });

            const resultModel = await storageOperations.models.update({
                model
            });

            await updateManager(context, resultModel);

            await onModelAfterUpdate.publish({
                input: data,
                original,
                model: resultModel
            });

            return resultModel;
        } catch (ex) {
            await onModelUpdateError.publish({
                input: data,
                model,
                original,
                error: ex
            });

            throw ex;
        }
    };
    const updateModelDirect: CmsModelContext["updateModelDirect"] = async params => {
        const { model: initialModel, original } = params;

        const model: CmsModel = {
            ...initialModel,
            tenant: initialModel.tenant || getTenant().id,
            locale: initialModel.locale || getLocale().code,
            webinyVersion: context.WEBINY_VERSION
        };

        try {
            await onModelBeforeUpdate.publish({
                input: {} as CmsModelUpdateInput,
                original,
                model
            });

            const resultModel = await storageOperations.models.update({
                model
            });

            await updateManager(context, resultModel);

            clearModelsCache();

            await onModelAfterUpdate.publish({
                input: {} as CmsModelUpdateInput,
                original,
                model: resultModel
            });

            return resultModel;
        } catch (ex) {
            await onModelUpdateError.publish({
                input: {} as CmsModelUpdateInput,
                original,
                model,
                error: ex
            });
            throw ex;
        }
    };
    const createModelFrom: CmsModelContext["createModelFrom"] = async (modelId, input) => {
        await checkModelPermissions("w");
        /**
         * Get a model record; this will also perform ownership validation.
         */
        const original = await getModel(modelId);

        const result = await createModelCreateFromValidation().safeParseAsync({
            ...input,
            description: input.description || original.description
        });
        if (!result.success) {
            throw createZodError(result.error);
        }

        const data = removeUndefinedValues(result.data);

        const locale = await context.i18n.getLocale(data.locale || original.locale);
        if (!locale) {
            throw new NotFoundError(`There is no locale "${data.locale}".`);
        }
        /**
         * Use storage operations directly because we cannot get group from different locale via context methods.
         */
        const group = await context.cms.storageOperations.groups.get({
            id: data.group,
            tenant: original.tenant,
            locale: locale.code
        });
        if (!group) {
            throw new NotFoundError(`There is no group "${data.group}".`);
        }

        const identity = getIdentity();
        const model: CmsModel = {
            ...original,
            singularApiName: data.singularApiName,
            pluralApiName: data.pluralApiName,
            locale: locale.code,
            group: {
                id: group.id,
                name: group.name
            },
            icon: data.icon,
            name: data.name,
            modelId: data.modelId || "",
            description: data.description || "",
            createdBy: {
                id: identity.id,
                displayName: identity.displayName,
                type: identity.type
            },
            createdOn: new Date().toISOString(),
            savedOn: new Date().toISOString(),
            lockedFields: [],
            webinyVersion: context.WEBINY_VERSION
        };

        try {
            await onModelBeforeCreateFrom.publish({
                input: data,
                model,
                original
            });

            const createdModel = await storageOperations.models.create({
                model
            });

            clearModelsCache();

            await updateManager(context, model);

            await onModelAfterCreateFrom.publish({
                input: data,
                original,
                model: createdModel
            });

            return createdModel;
        } catch (ex) {
            await onModelCreateFromError.publish({
                input: data,
                original,
                model,
                error: ex
            });
            throw ex;
        }
    };
    const deleteModel: CmsModelContext["deleteModel"] = async modelId => {
        await checkModelPermissions("d");

        const model = await getModel(modelId);

        try {
            await onModelBeforeDelete.publish({
                model
            });

            try {
                await storageOperations.models.delete({
                    model
                });
            } catch (ex) {
                throw new WebinyError(
                    ex.message || "Could not delete the content model",
                    ex.code || "CONTENT_MODEL_DELETE_ERROR",
                    {
                        error: ex,
                        modelId: model.modelId
                    }
                );
            }

            clearModelsCache();

            await onModelAfterDelete.publish({
                model
            });

            managers.delete(model.modelId);
        } catch (ex) {
            await onModelDeleteError.publish({
                model,
                error: ex
            });
            throw ex;
        }
    };
    const initializeModel: CmsModelContext["initializeModel"] = async (modelId, data) => {
        /**
         * We require that users have write permissions to initialize models.
         * Maybe introduce another permission for it?
         */
        await checkModelPermissions("w");

        const model = await getModel(modelId);

        await onModelInitialize.publish({ model, data });

        return true;
    };
    return {
        onModelBeforeCreate,
        onModelAfterCreate,
        onModelCreateError,
        onModelBeforeCreateFrom,
        onModelAfterCreateFrom,
        onModelCreateFromError,
        onModelBeforeUpdate,
        onModelAfterUpdate,
        onModelUpdateError,
        onModelBeforeDelete,
        onModelAfterDelete,
        onModelDeleteError,
        onModelInitialize,
        clearModelsCache,
        getModel,
        listModels,
        async createModel(input) {
            return context.benchmark.measure("headlessCms.crud.models.createModel", async () => {
                return createModel(input);
            });
        },
        /**
         * Method does not check for permissions or ownership.
         * @internal
         */
        async updateModelDirect(params) {
            return context.benchmark.measure(
                "headlessCms.crud.models.updateModelDirect",
                async () => {
                    return updateModelDirect(params);
                }
            );
        },
        async createModelFrom(modelId, userInput) {
            return context.benchmark.measure(
                "headlessCms.crud.models.createModelFrom",
                async () => {
                    return createModelFrom(modelId, userInput);
                }
            );
        },
        async updateModel(modelId, input) {
            return context.benchmark.measure("headlessCms.crud.models.updateModel", async () => {
                return updateModel(modelId, input);
            });
        },
        async deleteModel(modelId) {
            return context.benchmark.measure("headlessCms.crud.models.deleteModel", async () => {
                return deleteModel(modelId);
            });
        },
        async initializeModel(modelId, data) {
            return context.benchmark.measure(
                "headlessCms.crud.models.initializeModel",
                async () => {
                    return initializeModel(modelId, data);
                }
            );
        },
        getEntryManager,
        getEntryManagers: () => managers
    };
};
