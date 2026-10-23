/**
 * Extensão planejada para autenticação/autorização de provedores.
 *
 * Este contrato NÃO implementa autenticação, NÃO valida tokens e NÃO deve
 * ser confundido com proteção ativa nos endpoints financeiros.
 *
 * Uma futura integração OIDC pode implementar este port na infraestrutura
 * e conectar sua resolução a um NestJS Guard.
 */
export interface ProviderIdentity {
  providerId: string;
  subject: string;
  scopes: readonly string[];
}

export interface ProviderIdentityPort {
  /**
   * Valida credenciais na camada de infraestrutura e retorna identidade.
   * Deve rejeitar credenciais inválidas, expiradas ou com audience incorreta.
   */
  authenticate(authorizationHeader: string): Promise<ProviderIdentity>;

  /** Garante que o provedor autenticado pode acessar o provedor solicitado. */
  assertAuthorizedProvider(
    identity: ProviderIdentity,
    requestedProviderId: string,
  ): Promise<void>;
}

export const PROVIDER_IDENTITY_PORT = Symbol('PROVIDER_IDENTITY_PORT');
