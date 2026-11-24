import { useId,type ReactNode } from "react";
export function TextField({label,value,onChange,multiline=false,max=2000,placeholder,required=false}:{label:string;value:string;onChange:(value:string)=>void;multiline?:boolean;max?:number;placeholder?:string;required?:boolean}){
 const id=useId();
 return <div className="video-field"><label htmlFor={id}>{label}{required&&<em>必填</em>}</label>{multiline?<textarea id={id} value={value} onChange={e=>onChange(e.target.value)} rows={3} maxLength={max} placeholder={placeholder} required={required}/>:<input id={id} value={value} onChange={e=>onChange(e.target.value)} maxLength={max} placeholder={placeholder} required={required}/>}</div>;
}
export function SelectField({label,value,onChange,children}:{label:string;value:string;onChange:(value:string)=>void;children:ReactNode}){const id=useId();return <div className="video-field"><label htmlFor={id}>{label}</label><select id={id} value={value} onChange={e=>onChange(e.target.value)}>{children}</select></div>;}
