export { classify, type ClassificationResult } from '../classifier/classifier';
export { quickClassify } from '../classifier/signals';
export { route } from '../router/router';
export { loadConfig, type RouterConfig, type RouterConfigInput } from '../router/config';
export { TIERS, type ExecutionConfig, type RoutingDecision, type RoutingSource, type Tier } from '../types';
export { createRouter, type RouterInstance, type SessionStats } from './factory';
