// Gerado por scripts/generate-api.mjs a partir de contracts/openapi.yaml.
// Não edite à mão: altere o contrato e rode `npm run generate`.
export interface paths {
    "/health": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Verificação de saúde (não depende de banco nem de LiveKit) */
        get: operations["getHealth"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/auth/register": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Cadastro com convite de uso único */
        post: operations["register"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/auth/login": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Login com usuário e senha */
        post: operations["login"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/channels": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Lista os canais de voz, em ordem de posição */
        get: operations["listChannels"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/livekit/token": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Emite o token de acesso à sala LiveKit de um canal
         * @description `voice` publica e assina. `spectator` é oculto, não publica e só assiste (Modo Espectador).
         */
        post: operations["createLiveKitToken"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
}
export type webhooks = Record<string, never>;
export interface components {
    schemas: {
        HealthResponse: {
            /** @enum {string} */
            status: "ok";
            /**
             * @description Endereço WebSocket público do LiveKit (o mesmo de LiveKitTokenResponse.url). O cliente o lê ao
             *     validar o endereço do servidor para montar a CSP antes de qualquer login. Não é segredo.
             */
            livekitUrl: string;
        };
        ErrorResponse: {
            error: string;
            /** @description Detalhes opcionais (por exemplo, o campo inválido) */
            details?: unknown;
        };
        User: {
            id: string;
            username: components["schemas"]["Username"];
            isAdmin: boolean;
            /** Format: date-time */
            createdAt: string;
        };
        Username: string;
        RegisterRequest: {
            inviteCode: string;
            username: components["schemas"]["Username"];
            password: string;
        };
        LoginRequest: {
            username: components["schemas"]["Username"];
            password: string;
        };
        AuthResponse: {
            token: string;
            user: components["schemas"]["User"];
        };
        Channel: {
            id: string;
            name: string;
            position: number;
        };
        ChannelListResponse: {
            channels: components["schemas"]["Channel"][];
        };
        PublicUser: {
            id: string;
            username: components["schemas"]["Username"];
        };
        PresenceParticipant: {
            userId: string;
            username: string;
            isScreenSharing: boolean;
        };
        ChannelPresence: {
            channelId: string;
            participants: components["schemas"]["PresenceParticipant"][];
        };
        /** @description Primeira mensagem obrigatória do cliente. O token de sessão NÃO vai na URL (URLs vazam em logs). */
        WsClientAuth: {
            /** @enum {string} */
            type: "auth";
            token: string;
        };
        /** @description Chama a atenção de um usuário conectado. */
        WsClientMention: {
            /** @enum {string} */
            type: "mention";
            targetUserId: string;
            message?: string;
            /** @description Identificador escolhido pelo cliente, devolvido na confirmação ou no erro */
            ref?: string;
        };
        /** @description Estado completo da presença, enviado logo após a autenticação. As mudanças seguintes têm seq maior. */
        WsSnapshot: {
            /** @enum {string} */
            type: "snapshot";
            /** Format: int64 */
            seq: number;
            channels: components["schemas"]["ChannelPresence"][];
        };
        WsParticipantJoined: {
            /** @enum {string} */
            type: "participant_joined";
            /** Format: int64 */
            seq: number;
            channelId: string;
            participant: components["schemas"]["PresenceParticipant"];
        };
        /** @description O usuário saiu do canal (isso também encerra qualquer transmissão dele). */
        WsParticipantLeft: {
            /** @enum {string} */
            type: "participant_left";
            /** Format: int64 */
            seq: number;
            channelId: string;
            userId: string;
        };
        WsStreamStarted: {
            /** @enum {string} */
            type: "stream_started";
            /** Format: int64 */
            seq: number;
            channelId: string;
            userId: string;
        };
        WsStreamStopped: {
            /** @enum {string} */
            type: "stream_stopped";
            /** Format: int64 */
            seq: number;
            channelId: string;
            userId: string;
        };
        /** @description Entregue ao destinatário. Não tem seq (é por usuário, não estado compartilhado) e não é persistida. */
        WsMention: {
            /** @enum {string} */
            type: "mention";
            from: components["schemas"]["PublicUser"];
            message?: string;
            /** Format: date-time */
            sentAt: string;
        };
        /** @description Confirma ao remetente que a menção foi entregue a pelo menos uma conexão do destinatário. */
        WsMentionSent: {
            /** @enum {string} */
            type: "mention_sent";
            ref?: string;
        };
        /** @enum {string} */
        WsErrorCode: "unauthorized" | "bad_message" | "rate_limited_sender" | "rate_limited_recipient" | "recipient_offline" | "unknown_user" | "self_mention";
        WsError: {
            /** @enum {string} */
            type: "error";
            code: components["schemas"]["WsErrorCode"];
            message: string;
            ref?: string;
        };
        /** @enum {string} */
        LiveKitRole: "voice" | "spectator";
        LiveKitTokenRequest: {
            channelId: string;
            role: components["schemas"]["LiveKitRole"];
        };
        LiveKitTokenResponse: {
            token: string;
            /** @description Endereço WebSocket do LiveKit que o cliente deve usar */
            url: string;
            roomName: string;
        };
    };
    responses: {
        /** @description Requisição inválida */
        BadRequest: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["ErrorResponse"];
            };
        };
        /** @description Não autenticado ou credenciais inválidas */
        Unauthorized: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["ErrorResponse"];
            };
        };
        /** @description Recurso não encontrado */
        NotFound: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["ErrorResponse"];
            };
        };
        /** @description Conflito (nome de usuário já em uso) */
        Conflict: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["ErrorResponse"];
            };
        };
        /** @description Corpo da requisição maior que o limite */
        PayloadTooLarge: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["ErrorResponse"];
            };
        };
        /** @description Limite de tentativas excedido */
        TooManyRequests: {
            headers: {
                /** @description Segundos até a próxima tentativa */
                "Retry-After"?: number;
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["ErrorResponse"];
            };
        };
        /** @description Erro interno */
        InternalError: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["ErrorResponse"];
            };
        };
    };
    parameters: never;
    requestBodies: never;
    headers: never;
    pathItems: never;
}
export type $defs = Record<string, never>;
export interface operations {
    getHealth: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Servidor vivo */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HealthResponse"];
                };
            };
        };
    };
    register: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["RegisterRequest"];
            };
        };
        responses: {
            /** @description Usuário criado */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AuthResponse"];
                };
            };
            400: components["responses"]["BadRequest"];
            409: components["responses"]["Conflict"];
            413: components["responses"]["PayloadTooLarge"];
            429: components["responses"]["TooManyRequests"];
            500: components["responses"]["InternalError"];
        };
    };
    login: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["LoginRequest"];
            };
        };
        responses: {
            /** @description Login realizado */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AuthResponse"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            413: components["responses"]["PayloadTooLarge"];
            429: components["responses"]["TooManyRequests"];
            500: components["responses"]["InternalError"];
        };
    };
    listChannels: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Canais */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ChannelListResponse"];
                };
            };
            401: components["responses"]["Unauthorized"];
            500: components["responses"]["InternalError"];
        };
    };
    createLiveKitToken: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["LiveKitTokenRequest"];
            };
        };
        responses: {
            /** @description Token emitido */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["LiveKitTokenResponse"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            404: components["responses"]["NotFound"];
            413: components["responses"]["PayloadTooLarge"];
            500: components["responses"]["InternalError"];
        };
    };
}
