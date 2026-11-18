import { CanActivate, ExecutionContext, Injectable, SetMetadata } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { DomainError } from "@medos/shared";
import type { FeatureKey } from "../modules/settings/settings.service";
import { SettingsService } from "../modules/settings/settings.service";
import type { AuthedRequest } from "./request-context";

export const FEATURE = "requiredFeature";
/** Marks a controller or a route as belonging to a module or feature that a facility can switch off (configuration, not code forks). */
export const Feature = (key: FeatureKey) => SetMetadata(FEATURE, key);

/** Runs after authentication: refuses requests for a module the facility has disabled. */
@Injectable()
export class FeatureGuard implements CanActivate {
  constructor(private readonly reflector: Reflector, private readonly settings: SettingsService) {}

  async canActivate(ec: ExecutionContext): Promise<boolean> {
    const key = this.reflector.getAllAndOverride<FeatureKey | undefined>(FEATURE, [ec.getHandler(), ec.getClass()]);
    if (!key) return true;
    const req = ec.switchToHttp().getRequest<AuthedRequest>();
    if (!req.ctx) return true; // public route: nothing to check
    const enabled = await this.settings.isEnabled(req.ctx.tenantId, req.ctx.facilityId, key);
    if (!enabled) throw new DomainError("FEATURE_DISABLED", "This module is not enabled for your facility", 403);
    return true;
  }
}
