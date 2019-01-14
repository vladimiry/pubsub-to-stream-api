import jsan from "jsan";
import deserializeError from "deserialize-error";
import uuid from "uuid-browser";
import {Observable, Subscriber, Subscription} from "rxjs";
import {serializerr} from "serializerr";

import * as Model from "./model";

const ONE_SECOND_MS = 1000;

// tslint:disable-next-line:no-empty
const emptyFunction: Model.LoggerFn = () => {};

const stubLogger: Record<"info" | "error", Model.LoggerFn> = {
    info: emptyFunction,
    error: emptyFunction,
};

class Service<Actions extends Model.ActionsRecord<Extract<keyof Actions, string>>> {
    private static readonly defaultNotificationWrapper: Required<Model.CallOptions>["notificationWrapper"]
        = ((fn) => fn()) as (fn: (...args: Model.TODO[]) => void) => void;

    private readonly callsListenersMap
        = new WeakMap<Model.Emitters["listener"], Map<string, ReturnType<typeof Service.prototype.buildChannelCallsMap>>>();

    private readonly options: { channel: string; callTimeoutMs: number; logger: Model.Logger };

    constructor(
        {
            channel,
            callTimeoutMs = ONE_SECOND_MS * 3,
            logger = stubLogger,
        }: {
            channel: string;
            callTimeoutMs?: number;
            logger?: Model.Logger;
        },
    ) {
        this.options = {channel, callTimeoutMs, logger};
    }

    public register<ActionName extends keyof Actions>(
        actions: Actions,
        em: Model.CombinedEventEmitter,
        {
            requestResolver,
            logger = this.options.logger,
        }: {
            requestResolver?: Model.RequestResolver;
            logger?: Model.Logger;
        } = {},
    ): () => void {
        const {channel} = this.options;
        const subscriptions = new Map<Model.PayloadUid, Subscription>();
        const arrayOfEvenNameAndHandler: Model.Arguments<typeof em.on> = [
            channel,
            (...args: Model.TODO[]) => {
                const resolvedArgs = requestResolver ? requestResolver(...args) : false;
                const payload: Model.RequestPayload<ActionName> | Model.ResponsePayload<ActionName, Model.TODO> = resolvedArgs
                    ? resolvedArgs.payload
                    : args[0];
                const {name, uid} = payload;
                const loggingData = JSON.stringify({channel, name, type: payload.type, uid}); // WARN: don't log the actual data

                // unsubscribe forced on the client side, normally on "finishPromise" resolving
                if (payload.type === "unsubscribe") {
                    const toUnsubscribe = subscriptions.get(uid);
                    if (toUnsubscribe) {
                        toUnsubscribe.unsubscribe();
                        subscriptions.delete(uid);
                        logger.info(`provider.unsubscribe: ${loggingData}`);
                        logger.info(`subscription removed: ${loggingData} ${JSON.stringify({subscriptionsCount: subscriptions.size})}`);
                    }
                    return;
                }

                if (payload.type !== "request") {
                    return;
                }

                const ctx: Model.ActionContext<typeof args> = {[Model.ACTION_CONTEXT_SYMBOL]: {args}};
                const action: Model.Action | Model.ActionWithoutInput = actions[name];
                const actionResult: ReturnType<typeof action> = "data" in payload
                    ? (action as Model.Action).call(ctx, payload.data)
                    : (action as Model.ActionWithoutInput).call(ctx);

                type Output = Model.UnpackedActionResult<typeof actionResult>;
                type ActualResponsePayload = Model.ResponsePayload<typeof name, Output>;

                const emitter = resolvedArgs
                    ? resolvedArgs.emitter
                    : em;
                const response: ActualResponsePayload = {uid, name, type: "response"};
                const subscription = actionResult.subscribe(
                    (value: Model.TODO) => {
                        const responseData = payload.serialization === "jsan" ? jsan.stringify(value, null, null, {refs: true}) : value;
                        const output: ActualResponsePayload = {...response, data: responseData};
                        emitter.emit(channel, output);
                        logger.info(`provider.emit: ${loggingData}`);
                    },
                    (error: Error) => {
                        const output: ActualResponsePayload = {...response, error: serializerr(error)};
                        emitter.emit(channel, output);
                        logger.error(`provider.error: ${loggingData}`, error);
                        setTimeout(() => unsubscribe, 0);
                    },
                    () => {
                        const output: ActualResponsePayload = {...response, complete: true};
                        emitter.emit(channel, output);
                        logger.info(`provider.complete: ${loggingData}`);
                        setTimeout(() => unsubscribe, 0);
                    }, // TODO emit "complete" event to close observable on client side
                );
                const unsubscribe = () => {
                    subscription.unsubscribe();
                    subscriptions.delete(uid);
                    logger.info(`subscription removed: ${loggingData} ${JSON.stringify({subscriptionsCount: subscriptions.size})}`);
                };

                subscriptions.set(uid, subscription);
                logger.info(`subscription added: ${loggingData} ${JSON.stringify({subscriptionsCount: subscriptions.size})}`);
            },
        ];

        em.on(...arrayOfEvenNameAndHandler);

        logger.info(`registered: ${JSON.stringify({actionsKeys: Object.keys(actions)})}`);

        return () => {
            em.off(...arrayOfEvenNameAndHandler);
            subscriptions.forEach((subscription) => subscription.unsubscribe());
            subscriptions.clear();
            logger.info(`"unregister" called`);
        };
    }

    // TODO track function parameter extracting issue https://github.com/Microsoft/TypeScript/issues/24068
    public call<ActionName extends keyof Actions>(
        name: ActionName,
        options: Model.CallOptions,
        emitters: Model.Emitters | Model.EmittersResolver,
    ): Actions[ActionName] {
        type Return = ReturnType<Actions[ActionName]>;

        const self = this;
        const {emitter, listener} = typeof emitters === "function" ? emitters() : emitters;
        const {channel: emitChannel} = this.options;
        const subscribeChannel = options.listenChannel || this.options.channel;
        const runNotification = options.notificationWrapper || Service.defaultNotificationWrapper;

        this.ensureListeningSetup(subscribeChannel, listener);

        // tslint:disable:only-arrow-functions
        return function() {
            const request: Model.RequestPayload<ActionName> = {
                uid: uuid.v4(),
                type: "request",
                serialization: options.serialization,
                name,
                ...(arguments.length && {data: arguments[0]}),
            };

            return new Observable<Return>((observer: Subscriber<Return>) => {
                const callsByChannelMap = self.callsListenersMap.get(listener);
                const callsMap = callsByChannelMap && callsByChannelMap.get(subscribeChannel);

                if (!callsMap) { // not supposed to be undefined at this state
                    runNotification(() => observer.error(new Error(`Failed to resolve "${emitChannel}" channel's calls map`)));
                    return;
                }

                const timeoutId = setTimeout(
                    () => {
                        releaseTimeout();
                        runNotification(() => observer.error(new Error(
                            `Invocation timeout of "${name}" method on "${emitChannel}" channel with ${options.timeoutMs}ms timeout`,
                        )));
                    },
                    options.timeoutMs,
                );
                const releaseTimeout = () => {
                    clearTimeout(timeoutId);
                };
                const error = (e: Error) => {
                    releaseTimeout();
                    runNotification(() => observer.error(deserializeError(e)));
                };
                const complete = () => {
                    releaseTimeout();
                    runNotification(() => observer.complete());
                };

                if (options.finishPromise) {
                    options.finishPromise
                        .then(() => {
                            complete();
                            // sending forced unsubscribe signal to api provider
                            emitter.emit(emitChannel, {uid: request.uid, type: "unsubscribe"});
                        })
                        .catch(error);
                }

                // register call handler
                callsMap.set(
                    request.uid,
                    {
                        error,
                        complete,
                        next(data: Return) {
                            releaseTimeout();
                            runNotification(() => {
                                observer.next(options.serialization === "jsan"
                                    ? jsan.parse(data)
                                    : data,
                                );
                            });
                        },
                    },
                );

                // execute the call
                emitter.emit(emitChannel, request);
            });
        };
    }

    public caller(
        emiters: Model.Emitters | Model.EmittersResolver,
        defaultOptions: Model.CallOptions = {timeoutMs: this.options.callTimeoutMs},
    ) {
        return <ActionName extends keyof Actions>(name: ActionName, options: Model.CallOptions = defaultOptions) => this.call(
            name,
            {...defaultOptions, ...options},
            emiters,
        );
    }

    private ensureListeningSetup<ActionName extends keyof Actions>(channel: string, listener: Model.Emitters["listener"]) {
        type Return = ReturnType<Actions[keyof Actions]>;

        let callsByChannelMap = this.callsListenersMap.get(listener);

        if (callsByChannelMap && callsByChannelMap.has(channel)) {
            return;
        }

        const callsMap = this.buildChannelCallsMap();

        // register single handler per call channel
        listener.on( // TODO implement unsubscribe
            channel,
            (payload: Model.ResponsePayload<ActionName, Return> | Model.RequestPayload<ActionName>) => {
                const handler = callsMap.get(payload.uid);

                if (!handler || payload.type !== "response") {
                    return;
                }

                if ("error" in payload) {
                    handler.error(deserializeError(payload.error));
                    callsMap.delete(payload.uid);
                    return;
                }

                if ("data" in payload) {
                    handler.next(payload.data);
                }

                if ("complete" in payload && payload.complete) {
                    handler.complete();
                    callsMap.delete(payload.uid);
                }
            },
        );

        if (!callsByChannelMap) {
            callsByChannelMap = new Map();
            this.callsListenersMap.set(listener, callsByChannelMap);
        }

        // keep individual calls handlers
        callsByChannelMap.set(channel, callsMap);
    }

    private buildChannelCallsMap() {
        return new Map<string, Pick<Subscriber<ReturnType<Actions[keyof Actions]>>, "next" | "complete" | "error">>();
    }
}

export {
    Model,
    Service,
};
