<!--
 Copyright 2026 Atemukesu
 SPDX-License-Identifier: GPL-3.0-only
-->

<script setup lang="ts">
import { Check, CircleCheck, CloudOff, LoaderCircle, Play, Trash2 } from "@lucide/vue";
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import type { Track } from "../stores/player";
import { useCacheStore } from "../stores/cache";
import { coverPending, initial } from "../lib/format";
import { trackKey } from "../lib/sources";
import { pushToast } from "../lib/toast";
import { requestMeta } from "../directives/requestMeta";

const vRequestMeta = requestMeta;

const props = withDefaults(defineProps<{ track: Track; active?: boolean; playing?: boolean; removable?: boolean; selectable?: boolean; selected?: boolean }>(), { removable: false, selectable: false, selected: false });
const emit = defineEmits<{ play: [track: Track]; menu: [event: MouseEvent, track: Track]; remove: [track: Track]; openArtist: [artist: string]; toggle: [track: Track, event: MouseEvent] }>();
const { t } = useI18n();
const cache = useCacheStore();
const cached = computed(() => !props.track.unavailable && cache.isCached(trackKey(props.track)));
const unavailable = computed(() => !!props.track.unavailable);

function activate(event: MouseEvent) {
  if (unavailable.value) { pushToast("warning", t("library.unavailableHint")); return; }
  if (props.selectable) emit("toggle", props.track, event);
  else emit("play", props.track);
}
function openMenu(event: MouseEvent) {
  if (unavailable.value) return;
  emit("menu", event, props.track);
}
</script>

<template>
  <article
    v-request-meta="track"
    class="group relative rounded-3xl border bg-surface/90 backdrop-blur-sm p-3.5 shadow-sm transition-all"
    :title="unavailable ? t('library.unavailableHint') : undefined"
    :class="[unavailable ? 'cursor-not-allowed opacity-50' : 'cursor-pointer hover:-translate-y-1 hover:shadow-lg', selected ? 'border-accent ring-2 ring-accent/30' : 'border-line/70', !unavailable && !selected ? 'hover:border-accent/60' : '', active ? 'border-accent ring-1 ring-accent/20' : '']"
    @click="activate($event)"
    @contextmenu.prevent="openMenu($event)"
  >
    <div class="relative aspect-square w-full overflow-hidden rounded-2xl shadow-sm" :style="{ backgroundColor: track.color }">
      <span v-if="unavailable" class="absolute inset-0 grid place-items-center text-white/90"><CloudOff :size="26" :stroke-width="2" /></span>
      <img v-else-if="track.cover" :src="track.cover" alt="" loading="lazy" decoding="async" class="absolute inset-0 h-full w-full object-cover" />
      <span v-else-if="coverPending(track)" class="absolute inset-0 grid place-items-center text-white/90"><LoaderCircle :size="24" :stroke-width="2" class="animate-spin" /></span>
      <span v-else class="absolute inset-0 grid place-items-center text-5xl font-black text-white/90">{{ initial(track) }}</span>
      <button v-if="!selectable && !unavailable" class="absolute bottom-2.5 right-2.5 grid h-10 w-10 place-items-center rounded-full bg-accent text-accent-fg shadow-md opacity-0 transition-all hover:scale-110 active:scale-95 group-hover:opacity-100" :title="t('controls.play')" @click.stop="emit('play', track)">
        <Play :size="16" class="translate-x-[0.5px]" fill="currentColor" />
      </button>
      <button v-if="removable && !selectable" type="button" class="absolute right-2 top-2 grid h-8 w-8 place-items-center rounded-full bg-red-500/90 text-white shadow-sm opacity-0 transition-all hover:scale-105 group-hover:opacity-100" :title="t('library.playlists.removeTrack')" @click.stop="emit('remove', track)">
        <Trash2 :size="15" />
      </button>
      <span v-if="selectable" class="absolute left-2.5 top-2.5 grid h-7 w-7 place-items-center rounded-full border-2 transition-colors" :class="selected ? 'border-accent bg-accent text-accent-fg shadow-sm' : 'border-white/80 bg-black/30 text-transparent'"><Check :size="15" :stroke-width="3" /></span>
      <span v-if="active && playing && !selectable" class="absolute left-2.5 top-2.5 grid h-6 w-6 place-items-center rounded-full bg-accent text-accent-fg shadow-sm"><span class="ak-eq"><i></i><i></i><i></i></span></span>
    </div>
    <div class="mt-3 flex min-w-0 items-center gap-1.5"><p class="truncate text-sm font-semibold tracking-wide" :class="active ? 'text-accent' : ''">{{ track.title }}</p><CloudOff v-if="unavailable" :size="14" class="shrink-0 text-dim" :aria-label="t('library.unavailable')" /><CircleCheck v-else-if="cached" :size="14" class="shrink-0 text-accent" :aria-label="t('library.cached')" /></div>
    <button v-if="track.artist && !unavailable" type="button" class="block w-fit max-w-full truncate text-left text-xs text-muted transition-colors hover:text-accent" :title="t('library.openArtist')" @click.stop="emit('openArtist', track.artist)">{{ track.artist }}</button>
    <p v-else class="truncate text-xs text-muted">{{ track.artist }}</p>
  </article>
</template>
