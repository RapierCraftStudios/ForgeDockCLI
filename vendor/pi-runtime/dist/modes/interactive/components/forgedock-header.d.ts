export interface ForgeDockBrandEnvironment {
    isTTY?: boolean;
    env?: NodeJS.ProcessEnv;
}
export declare function shouldAnimateForgeDockBrand({ isTTY, env }?: ForgeDockBrandEnvironment): boolean;
/** Position of the diagonal shine band for a zero-based animation frame. */
export declare function forgeDockBrandShinePosition(frame: number, frames?: number): number;
export declare function renderForgeDockBrand(version: string, shinePosition?: number): string;
//# sourceMappingURL=forgedock-header.d.ts.map