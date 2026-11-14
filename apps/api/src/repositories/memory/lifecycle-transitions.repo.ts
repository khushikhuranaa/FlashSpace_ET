import type { LifecycleTransition } from '@flashspace/shared';
import type { LifecycleTransitionsRepo } from '../data-layer.interface.js';

export class MemoryLifecycleTransitionsRepo implements LifecycleTransitionsRepo {
  private readonly transitions = new Map<string, LifecycleTransition>();

  insert(transition: LifecycleTransition): LifecycleTransition {
    this.transitions.set(transition.id, transition);
    return transition;
  }

  findById(id: string): LifecycleTransition | undefined {
    return this.transitions.get(id);
  }

  listForSpace(spaceId: string, limit?: number): LifecycleTransition[] {
    return [...this.transitions.values()]
      .filter((t) => t.spaceId === spaceId)
      .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
      .slice(0, limit ?? 50);
  }
}
