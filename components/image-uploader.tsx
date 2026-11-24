"use client";

import { ArrowLeft, ArrowRight, ImagePlus, Plus, X } from "lucide-react";
import { useRef, useState } from "react";
import type { StudioImage } from "@/lib/types";
import { MAX_IMAGES } from "@/lib/constants";

type Props = { images: StudioImage[]; disabled: boolean; onAdd: (files: File[]) => void; onRemove: (id: string) => void; onMove: (index: number, delta: number) => void };

export function ImageUploader({ images, disabled, onAdd, onRemove, onMove }: Props) {
  const input = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  return <section className="input-section" aria-labelledby="upload-title">
    <div className="section-heading"><div className="section-name"><span className="step-number">01</span><h2 id="upload-title">先放入你的照片</h2></div><span className="subtle">{images.length} / {MAX_IMAGES}</span></div>
    <input ref={input} id="image-files" data-testid="image-files" type="file" multiple accept="image/jpeg,image/png,image/webp" className="sr-only" tabIndex={-1} disabled={disabled} onChange={(event) => { onAdd(Array.from(event.target.files || [])); event.target.value = ""; }} />
    {images.length > 0 && <div className="image-grid">
      {images.map((image, index) => <div className="image-tile" key={image.id} data-testid="image-tile" data-image-id={image.id}>
        {/* 本地 object URL 不需要经过 Next 图片优化服务。 */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={image.preview} alt={`图片 ${index + 1}：${image.file.name}`} />
        <span className="image-order">{String(index + 1).padStart(2, "0")}</span>
        <button className="image-remove" type="button" onClick={() => onRemove(image.id)} disabled={disabled} aria-label={`删除图片 ${index + 1}`}><X size={13} /></button>
        <div className="image-tools"><button type="button" aria-label={`前移图片 ${index + 1}`} disabled={disabled || index === 0} onClick={() => onMove(index, -1)}><ArrowLeft size={13} /></button><span>{index === 0 ? "封面" : `图 ${index + 1}`}</span><button type="button" aria-label={`后移图片 ${index + 1}`} disabled={disabled || index === images.length - 1} onClick={() => onMove(index, 1)}><ArrowRight size={13} /></button></div>
      </div>)}
      {images.length < MAX_IMAGES && <button type="button" className="add-tile" aria-label="继续添加图片" disabled={disabled} onClick={() => input.current?.click()}><Plus size={22} /><span>继续添加</span></button>}
    </div>}
    {images.length < MAX_IMAGES && <button type="button" className={`upload-zone ${dragging ? "is-dragging" : ""} ${images.length ? "compact" : ""}`} disabled={disabled}
      onClick={() => input.current?.click()}
      onDragOver={(event) => { event.preventDefault(); if (!disabled) setDragging(true); }}
      onDragLeave={() => setDragging(false)}
      onDrop={(event) => { event.preventDefault(); setDragging(false); if (!disabled) onAdd(Array.from(event.dataTransfer.files)); }}>
      {!images.length && <span className="upload-icon"><ImagePlus size={25} strokeWidth={1.5} /><span className="tiny-spark">✧</span></span>}
      <span><strong>{dragging ? "松开鼠标，放入照片" : "点击上传"}</strong>{!dragging && "，或拖拽图片到这里"}</span>
      <small>JPG / PNG / WebP · 每张不超过 5MB</small>
    </button>}
    <p className="field-hint">按发布顺序排列，第一张用作封面参考。</p>
  </section>;
}
